# Public documentation site

Own the future VitePress build, navigation, deployment integration and accessibility of the docs site. Content source is [docs/guide](../../docs/guide/README.md). Read [product](../../docs/specs/product.md) for behavior and [design policy](../../design.md) for source ownership.

Publish only reviewed user-guide content. Exclude `AGENTS.md`, internal specs, operational runbooks, research and secrets from the public build. Keep the site separately deployable, linked from the web app. Do not claim planned steps work until the product has been verified.

## Checklist

- [ ] SITE-1 / G9: configure static docs build and explicit source/publication allowlist.
- [ ] SITE-2 / G9: add navigation for getting started, blocks, costs, connectors, custody and troubleshooting.
- [ ] SITE-3 / G9: verify links, keyboard navigation, mobile reading and matching application terminology.
- [ ] SITE-4 / G11: publish self-hosted connector guide after the distribution works.

Prerequisites: G7 and [guide checklist](../../docs/guide/AGENTS.md) before final screenshots/instructions. Coordinate deployment with [infra](../../infra/AGENTS.md). Tick with built-site checks, not Markdown drafts alone.
