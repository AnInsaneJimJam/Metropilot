# ECR, Secrets Manager containers, log groups and the private service-discovery namespace.
locals {
  secret_keys = { for k, v in jsondecode(file("${path.module}/../secret-keys.json")) : k => v if k != "_comment" }
  services    = ["api", "control", "executor", "runtime", "migrate"]
}

resource "aws_ecr_repository" "app" {
  name                 = var.project
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.allow_destroy_with_data
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 15 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 15 }
      action       = { type = "expire" }
    }]
  })
}

# One JSON secret per service; values are written by infra/scripts/put-secrets.sh, never by Terraform (so no
# secret value lands in Terraform state). recovery_window_in_days = 0 lets teardown delete them immediately.
resource "aws_secretsmanager_secret" "service" {
  for_each                = local.secret_keys
  name                    = "${var.project}/${var.env}/${each.key}"
  description             = "Keys: ${join(", ", each.value)}"
  recovery_window_in_days = 0
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(concat(local.services, ["proxy"]))
  name              = "/${var.project}/${var.env}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "monad.internal"
  description = "Private names for control, executor and the database"
  vpc         = aws_vpc.main.id
}

resource "aws_service_discovery_service" "internal" {
  for_each = toset(["control", "executor", "db"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  # ECS-managed services report health through the task lifecycle; the database registers its own IP.
  dynamic "health_check_custom_config" {
    for_each = each.key == "db" ? [] : [1]
    content {}
  }
  force_destroy = true
}
