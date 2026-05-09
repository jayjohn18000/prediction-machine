terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.62"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type        = string
  description = "Ohio deployment region for Stream A normalizer EC2."
  default     = "us-east-2"
}

variable "normalizer_git_branch" {
  type        = string
  default     = "phase-0/stream-a-schema-normalizer"
}

variable "github_repo_https" {
  type        = string
  description = "Public HTTPS git URL (omit tokens; private repos should use AMI bake or ephemeral deploy keys)."
}

variable "s3_bucket_name" {
  type    = string
  default = "pmci-events"
}

variable "ssm_database_url_parameter" {
  type        = string
  description = "SSM SecureString holding DATABASE_URL (+ optional NBA_GAME_IDS_EXTRA) for systemd EnvironmentFile sourcing."
  default     = "/pmci/normalizer/database_url"
}

variable "kalshi_credentials_parameter" {
  type        = string
  description = "SecureString newline-delimited KALSHI_PROD_* env block (mirror Fly secrets)."
  default     = "/pmci/normalizer/kalshi_prod_env"
}

data "aws_ssm_parameter" "al2023_amd64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_vpc" "pmci_scanner_vpc" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name    = "pmci-scanner-ohio"
    Project = "prediction-machine-phase0"
  }
}

resource "aws_internet_gateway" "pmci_scanner_gw" {
  vpc_id = aws_vpc.pmci_scanner_vpc.id
  tags = {
    Name = "pmci-scanner-ohio-gw"
  }
}

resource "aws_subnet" "pmci_public" {
  vpc_id                  = aws_vpc.pmci_scanner_vpc.id
  availability_zone       = "${var.aws_region}a"
  cidr_block              = "10.42.12.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name = "pmci-scanner-ohio-public-a"
  }
}

resource "aws_route_table" "pmci_public_rt" {
  vpc_id = aws_vpc.pmci_scanner_vpc.id
  tags = {
    Name = "pmci-scanner-ohio-public-rt"
  }
}

resource "aws_route" "internet" {
  route_table_id         = aws_route_table.pmci_public_rt.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.pmci_scanner_gw.id
}

resource "aws_route_table_association" "public_assoc" {
  subnet_id      = aws_subnet.pmci_public.id
  route_table_id = aws_route_table.pmci_public_rt.id
}

resource "aws_security_group" "pmci_normalizer" {
  name_prefix = "pmci-normalizer-"
  vpc_id      = aws_vpc.pmci_scanner_vpc.id
  description = "Egress-only security group — reach Supabase/Kalshi/S3/AWS APIs over HTTPS."

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "pmci-normalizer-egress-only"
  }
}

resource "aws_s3_bucket" "events" {
  bucket = var.s3_bucket_name

  tags = {
    Purpose = "pmci-phase0-raw-events"
    Project = "prediction-machine-phase0"
  }
}

resource "aws_s3_bucket_public_access_block" "events_blk" {
  bucket                  = aws_s3_bucket.events.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "normalizer_s3_put" {
  statement {
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.events.arn}/raw/*"]
  }
}

resource "aws_iam_policy" "normalizer_events_put" {
  name_prefix = "pmci-normalizer-s3"
  policy      = data.aws_iam_policy_document.normalizer_s3_put.json
}

data "aws_iam_policy_document" "normalizer_ssm_read" {
  statement {
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "kms:Decrypt",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "normalizer_ssm" {
  name_prefix = "pmci-normalizer-ssm"
  policy      = data.aws_iam_policy_document.normalizer_ssm_read.json
}

resource "aws_iam_role" "normalizer_ec2_role" {
  name_prefix        = "pmci-normalizer-ec2-"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "ssm_managed" {
  role       = aws_iam_role.normalizer_ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "s3_put" {
  role       = aws_iam_role.normalizer_ec2_role.name
  policy_arn = aws_iam_policy.normalizer_events_put.arn
}

resource "aws_iam_role_policy_attachment" "ssm_read_inline" {
  role       = aws_iam_role.normalizer_ec2_role.name
  policy_arn = aws_iam_policy.normalizer_ssm.arn
}

resource "aws_iam_instance_profile" "normalizer" {
  name_prefix = "pmci-normalizer-"
  role        = aws_iam_role.normalizer_ec2_role.name
}

locals {
  user_data = templatefile("${path.module}/userdata.sh.tpl", {
    git_branch        = var.normalizer_git_branch
    git_repo_https    = var.github_repo_https
    aws_region        = var.aws_region
    ssm_database_name = var.ssm_database_url_parameter
    ssm_kalshi_name   = var.kalshi_credentials_parameter
    s3_bucket         = var.s3_bucket_name
  })
}

resource "aws_instance" "normalizer" {
  ami                         = nonsensitive(trimspace(data.aws_ssm_parameter.al2023_amd64.value))
  instance_type               = "t3.micro"
  iam_instance_profile        = aws_iam_instance_profile.normalizer.name
  subnet_id                   = aws_subnet.pmci_public.id
  vpc_security_group_ids      = [aws_security_group.pmci_normalizer.id]
  associate_public_ip_address = true
  monitoring                  = true
  user_data                   = sensitive(local.user_data)

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 24
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name              = "pmci-normalizer"
    GitBranchDesired  = var.normalizer_git_branch
    Stream            = "A-scanner-ingest"
  }
}

output "instance_id" {
  value       = aws_instance.normalizer.id
  description = "EC2 identifier for aws ssm start-session targeting."
}

output "public_subnet_id" {
  value = aws_subnet.pmci_public.id
}

output "bucket_name" {
  value       = aws_s3_bucket.events.id
  description = "Raw envelopes land under prefix raw/."
}
