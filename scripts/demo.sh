#!/usr/bin/env bash
# Request several variants of one image and show how each one was served.
# Usage: scripts/demo.sh <s3-key>        e.g. scripts/demo.sh photo.jpg
set -euo pipefail

KEY="${1:?usage: scripts/demo.sh <s3-key>}"
STACK_NAME="${STACK_NAME:-image-transformation}"
REGION="${AWS_REGION:-us-east-1}"

BASE="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ImageBaseUrl'].OutputValue | [0]" --output text)"

show() {
  local label="$1" url="$2"; shift 2
  local out
  out="$(curl -sS -o /dev/null -D - -w 'size=%{size_download}B time=%{time_total}s\n' "$@" "$url")"
  printf '%-34s %s | %s | %s | %s\n' "$label" \
    "$(echo "$out" | head -1 | tr -d '\r')" \
    "$(echo "$out" | grep -i '^x-cache:' | tr -d '\r' | cut -d' ' -f2-)" \
    "$(echo "$out" | grep -i '^content-type:' | tr -d '\r' | cut -d' ' -f2-)" \
    "$(echo "$out" | grep '^size=')"
}

echo "Base: $BASE"
echo
show "original format, 400px wide"      "$BASE/$KEY?w=400"
show "same request again (edge hit)"    "$BASE/$KEY?w=400"
show "thumbnail 150x150 cover"          "$BASE/$KEY?w=150&h=150&fit=cover"
show "WebP at quality 60"               "$BASE/$KEY?w=800&fmt=webp&q=60"
show "auto format (browser Accept)"     "$BASE/$KEY?w=800" -H 'Accept: image/avif,image/webp,*/*'
show "unknown parameter -> 400"         "$BASE/$KEY?w=400&evil=1"
show "missing image -> 404"             "$BASE/does-not-exist.jpg?w=100"
show "path traversal -> 400"            "$BASE/..%2F..%2Fetc%2Fpasswd.jpg"
echo
echo "Look at the x-cache column: 'Miss from cloudfront' means Lambda ran (or the derived"
echo "bucket answered); 'Hit from cloudfront' means the edge answered with no compute."
