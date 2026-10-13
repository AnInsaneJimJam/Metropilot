# Terraform (hosted demo on AWS)

Own the AWS hosting definition: network, security groups, ECS Fargate services, self-hosted Postgres on EC2,
CloudFront/ALB edge, ECR, Secrets Manager containers, logs and service discovery. Read
[hosting](../../docs/hosting/README.md) and [teardown](../../docs/hosting/TEARDOWN.md) first.

Never put a secret value in Terraform (variables, defaults or state): secrets are written by
`infra/scripts/put-secrets.sh` from the keys in `infra/secret-keys.json`. Every resource keeps the
`project`/`env` default tags; teardown verifies by them. Runtime tasks stay in private subnets with no internet
route, no task role and no secret. Pin provider versions exactly; commit `.terraform.lock.hcl`. Run `terraform fmt`
and `terraform validate`; applying is an explicit operator action.

## Checklist

- [ ] Hosted demo applied once from a clean account and torn down with TEARDOWN.md, with dated evidence.
