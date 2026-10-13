# Security groups. Ingress is only what each hop needs; egress is limited to HTTPS, Postgres on the database
# group and the internal service ports. The runtime group has no internet egress at all.
locals {
  ports = { api = 3001, control = 3002, executor = 3003, postgres = 5432 }
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTP from CloudFront origin-facing addresses only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "User API tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "control" {
  name        = "${local.name}-control"
  description = "Runtime control API and workers"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "executor" {
  name        = "${local.name}-executor"
  description = "Executor"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "runtime" {
  name        = "${local.name}-runtime"
  description = "Runtime workers: control and executor only, no internet"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "migrate" {
  name        = "${local.name}-migrate"
  description = "One-off migration task"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Self-hosted Postgres"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "endpoints" {
  name        = "${local.name}-endpoints"
  description = "VPC interface endpoints for runtime tasks"
  vpc_id      = aws_vpc.main.id
}

# ---- ALB -------------------------------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.api
  to_port                      = local.ports.api
}

# ---- API ---------------------------------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.api
  to_port                      = local.ports.api
}

# ---- control / executor: only runtime tasks reach them ---------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "control_from_runtime" {
  security_group_id            = aws_security_group.control.id
  referenced_security_group_id = aws_security_group.runtime.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.control
  to_port                      = local.ports.control
}

resource "aws_vpc_security_group_ingress_rule" "executor_from_runtime" {
  security_group_id            = aws_security_group.executor.id
  referenced_security_group_id = aws_security_group.runtime.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.executor
  to_port                      = local.ports.executor
}

# ---- egress shared by api, control, executor, migrate: HTTPS out (RPC, Privy, Envio, AI Gateway, ECR) + Postgres
resource "aws_vpc_security_group_egress_rule" "https_out" {
  for_each          = { api = aws_security_group.api.id, control = aws_security_group.control.id, executor = aws_security_group.executor.id, migrate = aws_security_group.migrate.id }
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "to_db" {
  for_each                     = { api = aws_security_group.api.id, control = aws_security_group.control.id, executor = aws_security_group.executor.id, migrate = aws_security_group.migrate.id }
  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.postgres
  to_port                      = local.ports.postgres
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  for_each                     = { api = aws_security_group.api.id, control = aws_security_group.control.id, executor = aws_security_group.executor.id, migrate = aws_security_group.migrate.id }
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = local.ports.postgres
  to_port                      = local.ports.postgres
}

# Postgres host: package installs, Secrets Manager, S3 backups and Session Manager over HTTPS (and HTTP for apt).
resource "aws_vpc_security_group_egress_rule" "db_out" {
  for_each          = { https = 443, http = 80 }
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

# ---- runtime: control, executor, endpoints, S3 (image layers) and nothing else ---------------------------------------
resource "aws_vpc_security_group_egress_rule" "runtime_to_control" {
  security_group_id            = aws_security_group.runtime.id
  referenced_security_group_id = aws_security_group.control.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.control
  to_port                      = local.ports.control
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_executor" {
  security_group_id            = aws_security_group.runtime.id
  referenced_security_group_id = aws_security_group.executor.id
  ip_protocol                  = "tcp"
  from_port                    = local.ports.executor
  to_port                      = local.ports.executor
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_endpoints" {
  security_group_id            = aws_security_group.runtime.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "runtime_to_s3" {
  security_group_id = aws_security_group.runtime.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_runtime" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.runtime.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

# Private DNS makes ECR, Secrets Manager and CloudWatch Logs resolve to these endpoints for the whole VPC, so every
# caller of those services must be admitted, not only runtimes (image pulls, secrets, logs, the DB password).
resource "aws_vpc_security_group_ingress_rule" "endpoints_from_services" {
  for_each                     = { api = aws_security_group.api.id, control = aws_security_group.control.id, executor = aws_security_group.executor.id, migrate = aws_security_group.migrate.id, db = aws_security_group.db.id }
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}
