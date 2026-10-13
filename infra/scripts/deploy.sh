#!/usr/bin/env bash
# Roll every service to the image recorded by build-push.sh (deploy.auto.tfvars.json) and wait until stable.
#   infra/scripts/deploy.sh            (shows the plan and asks before applying)
#   infra/scripts/deploy.sh -auto-approve
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-monad-hack}" AWS_REGION="${AWS_REGION:-us-east-1}"
tf="$(cd "$(dirname "$0")/../terraform" && pwd)"
[ -f "$tf/deploy.auto.tfvars.json" ] || { echo "run infra/scripts/build-push.sh first" >&2; exit 1; }
terraform -chdir="$tf" apply "$@"
cluster="$(terraform -chdir="$tf" output -raw cluster_name)"
aws ecs wait services-stable --cluster "$cluster" --services api control executor runtime runtime-live
echo "services stable on $(python3 -c 'import json; print(json.load(open("'"$tf"'/deploy.auto.tfvars.json"))["image_tag"])')"
echo "API: $(terraform -chdir="$tf" output -raw api_origin)"
