# Container entry

`entry.sh` selects the service a task runs from the one image (`api`, `control`, `executor`, `runtime`, `proxy`,
`migrate`, `prune`). Secrets arrive as environment variables from Secrets Manager; files go only under `/tmp`.
The runtime starts from an empty environment (`env -i`) because it refuses credential-shaped variables.

## Checklist

- [ ] Each command observed starting on Fargate ARM64.
