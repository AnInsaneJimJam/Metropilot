#!/bin/sh
# Container entry for the hosted services (one image, one command per ECS task):
#   entry.sh api | control | executor | runtime | proxy | migrate
# Secrets arrive as environment variables from Secrets Manager (ECS task definition); none are baked in.
set -eu
cd /app

case "${1:-}" in
  api)
    exec node apps/api/src/hosted.ts
    ;;
  control)
    # The Kimi verification evidence is a JSON secret; the broker reads it from a file under /tmp.
    if [ -n "${KIMI_VERIFICATION_JSON:-}" ]; then
      umask 077
      printf '%s' "$KIMI_VERIFICATION_JSON" > /tmp/kimi-verification.json
      export KIMI_VERIFICATION_FILE=/tmp/kimi-verification.json
    fi
    unset KIMI_VERIFICATION_JSON
    exec node apps/api/src/runtime-control/server.ts
    ;;
  executor)
    exec node apps/executor/src/main.ts
    ;;
  proxy)
    exec node infra/sidecar/workload-proxy.mjs
    ;;
  runtime)
    # The runtime refuses credential-shaped variables (AWS_*, *_TOKEN, ...). Fargate injects AWS_* variables, so
    # it starts from an empty environment with only what its closed configuration accepts. Its ID is bound to
    # the ECS task, matching the workload proxy beside it.
    id="$(node -e 'fetch(process.env.ECS_CONTAINER_METADATA_URI_V4 + "/task").then((r) => r.json()).then((t) => console.log("runtime-" + String(t.TaskARN).split("/").pop()))')"
    exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
      RUNTIME_ID="$id" RUNTIME_MODE="${RUNTIME_MODE:-paper}" RUNTIME_IMAGE_DIGEST="$RUNTIME_IMAGE_DIGEST" \
      RUNTIME_CONTROL_API_ORIGIN=http://127.0.0.1:3002 RUNTIME_EXECUTOR_ORIGIN=http://127.0.0.1:3003 RUNTIME_DEV_WORKLOAD=1 \
      node apps/runtime/src/main.ts
    ;;
  migrate)
    # Forward-only migrations, then the verified live catalog. The synthetic paper seed refuses non-local
    # databases by design (apps/api/src/db/cli.ts) and is never run here.
    node apps/api/src/db/cli.ts migrate
    exec node apps/api/src/db/cli.ts seed-live
    ;;
  prune)
    exec node apps/api/src/db/cli.ts prune
    ;;
  *)
    echo "usage: entry.sh api|control|executor|runtime|proxy|migrate|prune" >&2
    exit 2
    ;;
esac
