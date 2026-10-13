# One image for every hosted Node service (api, control, executor, runtime, workload proxy, migrate).
# Node runs the TypeScript sources directly (type stripping), as in development. No secrets are baked in; each
# ECS task chooses its command through infra/container/entry.sh and receives secrets from Secrets Manager.
# node:24.21.0-bookworm-slim, multi-arch index digest resolved 2026-10-14 (matches .node-version).
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=1 PNPM_HOME=/pnpm
# pnpm pinned to packageManager in package.json.
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm generate \
  && rm -rf apps/web/node_modules/.vite apps/web/dist .claude infra/terraform

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=root:root /app /app
RUN chmod 0755 /app/infra/container/entry.sh
# Non-root at runtime; the tree is root-owned and read-only to the process. Only /tmp is written (mounted as an
# ephemeral volume when the task's root filesystem is read-only).
USER node
ENTRYPOINT ["/app/infra/container/entry.sh"]
CMD ["usage"]
