#!/usr/bin/env bash
# Delete everything this project created.
# WARNING: this also deletes the images you uploaded to the source bucket.
set -euo pipefail

STACK_NAME="${STACK_NAME:-image-transformation}"
REGION="${AWS_REGION:-us-east-1}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null || true
}

for key in SourceBucketName DerivedBucketName; do
  bucket="$(out "$key")"
  if [ -n "$bucket" ] && [ "$bucket" != "None" ]; then
    echo "==> Emptying s3://$bucket"
    aws s3 rm "s3://$bucket" --recursive --region "$REGION" --only-show-errors
  fi
done

echo "==> Deleting stack $STACK_NAME (the CloudFront distribution takes a few minutes)"
aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
echo "Stack deleted."
