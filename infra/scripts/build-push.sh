#!/usr/bin/env bash
# Build the single service image for linux/arm64, push it to ECR tagged by git sha, and record the tag and the
# image digest for Terraform (infra/terraform/deploy.auto.tfvars.json, git-ignored). Run from the repo root.
#   infra/scripts/build-push.sh                 ordinary release (keeps the pinned runtime digest)
#   infra/scripts/build-push.sh --new-runtime   runtime behaviour changed: new pinned digest, relaunch agents
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
# Deployments pin the runtime image digest they launched with, and runtimes only claim runs pinned to their own
# digest. An ordinary release keeps the pinned runtime digest so running agents keep running; pass --new-runtime
# only when runtime behaviour changes, then relaunch running agents (stop, launch) so they pin the new runtime.
runtime="0x$hex"
if [ "${1:-}" != "--new-runtime" ] && [ -f "$tf/deploy.auto.tfvars.json" ]; then
  runtime="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime_image_digest"])' "$tf/deploy.auto.tfvars.json")"
fi
printf '{\n  "image_tag": "%s",\n  "runtime_image_digest": "%s"\n}\n' "$sha" "$runtime" > "$tf/deploy.auto.tfvars.json"
echo "pushed $repo:$sha ($digest)"
echo "wrote infra/terraform/deploy.auto.tfvars.json; next: infra/scripts/deploy.sh"
