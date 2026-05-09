#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/pmci-userdata.log | logger -t pmci-normalizer-userdata -s 2>/dev/console) 2>&1

GIT_REPO="${git_repo_https}"
GIT_BRANCH="${git_branch}"
AWS_REGION_VAR="${aws_region}"
SSM_DATABASE_PARAM="${ssm_database_name}"
SSM_KALSHI_PARAM="${ssm_kalshi_name}"
S3_BUCKET_NAME="${s3_bucket}"

dnf upgrade -y
dnf install -y git jq curl-minimal

curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
node --version
npm --version

install -d -m 0755 /opt/prediction-machine

if [[ ! -d /opt/prediction-machine/.git ]]; then
  git clone --depth 1 --branch "$GIT_BRANCH" "$GIT_REPO" /opt/prediction-machine
else
  git -C /opt/prediction-machine fetch origin "$GIT_BRANCH"
  git -C /opt/prediction-machine checkout "$GIT_BRANCH"
  git -C /opt/prediction-machine pull --ff-only origin "$GIT_BRANCH"
fi

pushd /opt/prediction-machine >/dev/null
npm ci --omit=dev --no-audit --no-fund
popd >/dev/null

DATABASE_URL_ENC="$(aws --region "$AWS_REGION_VAR" ssm get-parameter --name "$SSM_DATABASE_PARAM" --with-decryption --query Parameter.Value --output text)"
KALSHI_BLOCK="$(aws --region "$AWS_REGION_VAR" ssm get-parameter --name "$SSM_KALSHI_PARAM" --with-decryption --query Parameter.Value --output text)"

umask 077
TMPENV="$(mktemp)"
{
  printf '%s\n' "$DATABASE_URL_ENC"
  printf '\n'
  printf '%s\n' "$KALSHI_BLOCK"
  printf '\n'
  cat <<CFG
AWS_REGION=$AWS_REGION_VAR
MM_RUN_MODE=prod
S3_BUCKET=$S3_BUCKET_NAME
NBA_POLL_INTERVAL_MS=4000
PMCI_NORMALIZER_DB_SAMPLE_MS=4000
CFG
} >"$TMPENV"
mv "$TMPENV" /etc/pmci-normalizer.env
chmod 600 /etc/pmci-normalizer.env

install -m 0644 /opt/prediction-machine/infra/aws-ohio/files/pmci-normalizer.service /etc/systemd/system/pmci-normalizer.service

systemctl daemon-reload
systemctl enable pmci-normalizer.service
systemctl restart pmci-normalizer.service
