# Teardown (AWS + Vercel, end to end)

Removes everything [the hosting guide](README.md) created and proves nothing is left billing. Every AWS resource
carries the tags `project=monad-hack` and `env=demo`, which the final checks rely on. Run from the repository
root with profile `monad-hack` (`export AWS_PROFILE=monad-hack AWS_REGION=us-east-1`).

**Before you start (irreversible):** live funds belong to users, not to the platform. If any agent wallet holds
real MON or tokens, withdraw them first (Operate → Withdraw) and confirm the ledger shows zero. Privy wallets are
not deleted by this teardown; they remain in the Privy app owned by your authorization key.

## 1. Stop new work

```
TF=infra/terraform
CLUSTER=$(terraform -chdir=$TF output -raw cluster_name)
for s in runtime runtime-live api control executor; do
  aws ecs update-service --cluster "$CLUSTER" --service "$s" --desired-count 0 >/dev/null
done
aws ecs wait services-stable --cluster "$CLUSTER" --services runtime runtime-live api control executor
```

Runtimes go first so no run or trade starts while the API and executor finish what is in flight.

## 2. Final backup (optional, keep it outside this stack)

```
DB=$(terraform -chdir=$TF output -raw db_instance_id)
aws ssm start-session --target "$DB"          # then on the host:
sudo /usr/local/bin/monad-pg-backup && exit
BUCKET=$(terraform -chdir=$TF output -raw backup_bucket)
aws s3 cp --recursive "s3://$BUCKET/pg/" ./final-backup/   # keep locally (git-ignored path recommended)
```

## 3. Allow Terraform to delete data-holding resources

The backup bucket and ECR repository refuse deletion while non-empty unless `allow_destroy_with_data = true`.
Either set it in `terraform.tfvars` and apply once:

```
terraform -chdir=$TF apply -var allow_destroy_with_data=true -var 'desired_counts={api=0,control=0,executor=0,runtime=0,runtime_live=0}'
```

or empty them by hand:

```
aws s3 rm --recursive "s3://$BUCKET"
aws ecr batch-delete-image --repository-name monad-hack \
  --image-ids "$(aws ecr list-images --repository-name monad-hack --query 'imageIds' --output json)"
```

## 4. Destroy

```
terraform -chdir=$TF destroy -var allow_destroy_with_data=true \
  -var 'desired_counts={api=0,control=0,executor=0,runtime=0,runtime_live=0}'
```

Terraform orders the deletion itself (services → task definitions → load balancer and CloudFront → endpoints →
instance and volume → network). Expect:

- **CloudFront** takes 5–15 minutes to disable and delete; let it finish.
- **Secrets Manager** secrets are created with `recovery_window_in_days = 0`, so they are deleted immediately.
  If one was recreated by hand with a recovery window, force it:
  `aws secretsmanager delete-secret --secret-id monad-hack/demo/<service> --force-delete-without-recovery`.
- **Network interfaces** of stopped Fargate tasks or VPC endpoints can linger for a few minutes and block subnet or
  security-group deletion. If `destroy` fails on a subnet or security group, wait 5 minutes and rerun it.
  List leftovers: `aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc-id>`.
- **Task definitions** are deregistered (INACTIVE) rather than deleted; inactive revisions cost nothing. To remove
  them entirely: `aws ecs delete-task-definitions --task-definitions <family:revision>…` after deregistration.

## 5. Things Terraform does not own

| Leftover | Check | Remove |
| --- | --- | --- |
| CloudWatch log groups created by a task after its group was deleted | `aws logs describe-log-groups --log-group-name-prefix /monad-hack/` | `aws logs delete-log-group --log-group-name <name>` |
| EBS snapshots you took by hand | `aws ec2 describe-snapshots --owner-ids self --filters Name=tag:project,Values=monad-hack` | `aws ec2 delete-snapshot --snapshot-id <id>` |
| Unattached EBS volumes (if an apply was interrupted) | `aws ec2 describe-volumes --filters Name=tag:project,Values=monad-hack` | `aws ec2 delete-volume --volume-id <id>` |
| Elastic IPs (none are created; check anyway) | `aws ec2 describe-addresses` | `aws ec2 release-address --allocation-id <id>` |
| ECS service-linked role | `aws iam get-role --role-name AWSServiceRoleForECS` | harmless; leave it, or `aws iam delete-service-linked-role` once no ECS remains |
| Terraform state bucket (only if you used the S3 backend) | `aws s3 ls` | empty and delete it last, after `destroy` |

## 6. Vercel

```
cd apps/web && vercel project rm <project-name>     # or Vercel dashboard → Project → Settings → Delete
```

Also remove the project's environment variables and any custom domain attached in Vercel, and the `vercel.json`
rewrite if the repository stays public (`git rm apps/web/vercel.json`).

## 7. Revoke and rotate credentials

The hosted secrets were copies; revoke them at the source:

- **Privy:** remove the Vercel origin from the app's allowed origins; rotate the app secret
  (`PRIVY_APP_SECRET`); if the authorization key (`PRIVY_AUTHORIZATION_KEY`) should no longer control the wallets,
  move ownership or generate a new key with `node scripts/custody-proof.ts --new-key` before deleting the old one.
- **Envio:** delete the HyperSync API token in the Envio dashboard.
- **Vercel AI Gateway:** delete the `monad-kimi-demo` key in the Vercel dashboard.
- **RPC provider:** revoke any paid RPC key used in `CUSTODY_RPC` / `LIVE_RPC`.
- **Generated secrets** (database password, capability and workload secrets) died with the stack; delete them
  from your local `.env.hosting`.

## 8. Prove nothing is left billing

```
# No tagged resources remain (may take a few minutes to converge after deletes):
aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=monad-hack --query 'ResourceTagMappingList[].ResourceARN'
# Explicit checks for the costly kinds:
aws ecs list-clusters
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'
aws ec2 describe-instances --filters Name=tag:project,Values=monad-hack Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
aws ec2 describe-vpc-endpoints --filters Name=tag:project,Values=monad-hack --query 'VpcEndpoints[].VpcEndpointId'
aws ec2 describe-vpcs --filters Name=tag:project,Values=monad-hack --query 'Vpcs[].VpcId'
aws cloudfront list-distributions --query 'DistributionList.Items[].Comment'
aws secretsmanager list-secrets --query "SecretList[?starts_with(Name, 'monad-hack/')].Name"
aws ecr describe-repositories --query 'repositories[].repositoryName'
# Spend over the coming days should flatten to zero for these services:
aws ce get-cost-and-usage --time-period Start=$(date -u +%Y-%m-01),End=$(date -u -d tomorrow +%F) \
  --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

Every command should return an empty list (`[]` or nothing). Cost Explorer lags about a day; check again the next
day.

## 9. Local cleanup

```
rm -f infra/terraform/terraform.tfstate infra/terraform/terraform.tfstate.backup infra/terraform/deploy.auto.tfvars.json
rm -rf infra/terraform/.terraform
rm -f .env.hosting && rm -rf .secrets/privy-verification.pem   # after revoking the credentials above
docker image rm $(docker images --filter=reference='*monad-hack*' -q) 2>/dev/null || true
docker logout "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com" || true
```

Keep `final-backup/` only as long as you need it; it contains user data.
