# Terraform templates

Rendered by `templatefile()` (e.g. the Postgres host's first-boot script). Escape shell `${…}` as `$${…}`.
Templates receive identifiers only (ARNs, names, CIDRs), never secret values; secrets are fetched at runtime.

## Checklist

- [ ] Postgres first boot observed on the real instance (`/var/log/monad-db-init.log` ends with `postgres ready`).
