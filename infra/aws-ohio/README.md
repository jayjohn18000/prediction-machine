# AWS Ohio (`us-east-2`) — Stream A normalizer host

Terraform provisions a **t3.micro** EC2 instance (SSM-only access, public subnet with egress-only security group) plus the `pmci-events` S3 bucket for `raw/*` envelopes.

## Operator inputs

- `github_repo_https` — HTTPS clone URL (`terraform apply -var=...`). Private repos still need a reachable credential strategy (deploy key or AMI bake) — not automated here.
- SSM SecureStrings:
  - Default `/pmci/normalizer/database_url` — one line `DATABASE_URL=postgresql://...` for systemd `EnvironmentFile`.
  - Default `/pmci/normalizer/kalshi_prod_env` — newline-separated `KEY=value` block mirroring Fly `pmci-mm-runtime` Kalshi PROD secrets.

## Apply

```bash
cd infra/aws-ohio
terraform init
terraform plan  -var='github_repo_https=https://github.com/OWNER/prediction-machine.git'
terraform apply -var='github_repo_https=https://github.com/OWNER/prediction-machine.git'
```

User-data installs Node 20 via NodeSource, clones `normalizer_git_branch` (default **`phase-0/stream-a-schema-normalizer`**), runs `npm ci`, and enables `infra/aws-ohio/files/pmci-normalizer.service`.
