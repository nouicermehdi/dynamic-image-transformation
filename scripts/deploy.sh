#!/usr/bin/env bash
# Build and deploy the stack, then print the URLs you need.
# Usage: scripts/deploy.sh [alert-email]
# Optional: STACK_NAME=my-stack AWS_REGION=eu-west-1 scripts/deploy.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-image-transformation}"
REGION="${AWS_REGION:-us-east-1}"
ALERT_EMAIL="${1:-}"

cd "$(dirname "$0")/.."

for tool in sam aws node npm; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

echo "==> Running unit tests"
npm test --silent

echo "==> Building (installs sharp for Linux arm64)"
sam build

echo "==> Deploying stack $STACK_NAME to $REGION (CloudFront takes 5-10 minutes the first time)"
sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "AlertEmail=${ALERT_EMAIL}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

echo
echo "Image base URL : $(out ImageBaseUrl)"
echo "Source bucket  : $(out SourceBucketName)"
echo
echo "Next: aws s3 cp photo.jpg s3://$(out SourceBucketName)/photo.jpg"
echo "      scripts/demo.sh photo.jpg"
