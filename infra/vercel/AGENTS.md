# Vercel configuration

`vercel.json.template` is rendered to `apps/web/vercel.json` by `infra/scripts/vercel-config.sh` with the hosted
API origin. The studio calls `/v1` on its own origin, so the rewrite keeps session cookies first-party. Only public
values (`VITE_*`) belong in Vercel environment variables.

## Checklist

- [ ] Studio deployed on Vercel with the rewrite, sign-in and an event stream verified through it.
