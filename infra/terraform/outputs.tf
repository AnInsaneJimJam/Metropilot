output "api_origin" {
  description = "HTTPS origin of the API (put it in apps/web/vercel.json rewrites via infra/scripts/vercel-config.sh)."
  value       = var.custom_domain == "" ? "https://${aws_cloudfront_distribution.api.domain_name}" : "https://${var.custom_domain}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "db_instance_id" {
  description = "Postgres host; connect with: aws ssm start-session --target <id>"
  value       = aws_instance.db.id
}

output "db_private_ip" {
  value = aws_instance.db.private_ip
}

output "database_host" {
  description = "Private DNS name every service's DATABASE_URL uses."
  value       = "db.${aws_service_discovery_private_dns_namespace.internal.name}"
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "secret_arns" {
  value = { for k, v in aws_secretsmanager_secret.service : k => v.arn }
}

output "migrate_task" {
  description = "Values infra/scripts/migrate.sh needs to run the one-off migration task."
  value = {
    task_definition = aws_ecs_task_definition.service["migrate"].family
    subnets         = aws_subnet.public[*].id
    security_group  = aws_security_group.migrate.id
  }
}
