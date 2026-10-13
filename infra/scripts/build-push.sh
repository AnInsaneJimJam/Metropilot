#!/usr/bin/env bash
# Build the single service image for linux/arm64, push it to ECR tagged by git sha, and record the tag and the
# image digest for Terraform (infra/terraform/deploy.auto.tfvars.json, git-ignored). Run from the repo root.
#   infra/scripts/build-push.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-monad-hack}" AWS_REGION="${AWS_REGION:-us-east-1}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
tf="$root/infra/terraform"

repo="$(terraform -chdir="$tf" output -raw ecr_repository_url)"
registry="${repo%%/*}"
sha="$(git -C "$root" rev-parse --short=12 HEAD)"
if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; commit first so the image tag names exactly what it contains." >&2
  exit 1
fi

aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
docker buildx build --platform linux/arm64 --provenance=false -t "$repo:$sha" --push "$root"

digest="$(aws ecr describe-images --repository-name "${repo##*/}" --image-ids imageTag="$sha" --query 'imageDetails[0].imageDigest' --output text)"
hex="${digest#sha256:}"
printf '{\n  "image_tag": "%s",\n  "runtime_image_digest": "0x%s"\n}\n' "$sha" "$hex" > "$tf/deploy.auto.tfvars.json"
echo "pushed $repo:$sha ($digest)"
echo "wrote infra/terraform/deploy.auto.tfvars.json; next: infra/scripts/deploy.sh"
