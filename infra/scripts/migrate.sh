#!/usr/bin/env bash
# Run the one-off migrate task (forward-only migrations, then the verified live catalog) and wait for it.
#   infra/scripts/migrate.sh
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-monad-hack}" AWS_REGION="${AWS_REGION:-us-east-1}"
tf="$(cd "$(dirname "$0")/../terraform" && pwd)"
cluster="$(terraform -chdir="$tf" output -raw cluster_name)"
task="$(terraform -chdir="$tf" output -json migrate_task)"
family="$(echo "$task" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_definition"])')"
subnets="$(echo "$task" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["subnets"]))')"
sg="$(echo "$task" | python3 -c 'import json,sys; print(json.load(sys.stdin)["security_group"])')"

arn="$(aws ecs run-task --cluster "$cluster" --task-definition "$family" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
echo "migrate task $arn started; waiting"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn"
code="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" --query 'tasks[0].containers[0].exitCode' --output text)"
echo "migrate exited $code (logs: /monad-hack/demo/migrate)"
[ "$code" = "0" ]
