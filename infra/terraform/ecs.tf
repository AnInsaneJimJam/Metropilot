# ECS on Fargate (ARM64): api, control, executor, runtime workers (each with its workload proxy) and a one-off
# migrate task. Read-only root filesystems with an ephemeral /tmp; secrets injected from each service's JSON
# secret by its execution role.
locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
  internal = {
    control  = "http://control.${aws_service_discovery_private_dns_namespace.internal.name}:${local.ports.control}"
    executor = "http://executor.${aws_service_discovery_private_dns_namespace.internal.name}:${local.ports.executor}"
  }
  base_env = {
    api = {
      NODE_ENV             = "production"
      HOST                 = "0.0.0.0"
      PORT                 = tostring(local.ports.api)
      PUBLIC_ORIGIN        = var.public_origin
      RUNTIME_IMAGE_DIGEST = var.runtime_image_digest
      LIVE_OUTFLOWS        = "0" # nothing signs until the user sets service_env.api.LIVE_OUTFLOWS = "1"
    }
    control = {
      NODE_ENV             = "production"
      HOSTED               = "1"
      RUNTIME_CONTROL_PORT = tostring(local.ports.control)
    }
    executor = {
      NODE_ENV      = "production"
      HOSTED        = "1"
      EXECUTOR_PORT = tostring(local.ports.executor)
      EXECUTOR_LIVE = "0" # live trading needs EXECUTOR_LIVE = "1" and LIVE_OUTFLOWS = "1" in service_env.executor
      LIVE_OUTFLOWS = "0"
    }
    runtime = {
      RUNTIME_MODE         = "paper"
      RUNTIME_IMAGE_DIGEST = var.runtime_image_digest
    }
    migrate = { NODE_ENV = "production" }
  }
  env = { for s in local.services : s => merge(local.base_env[s], lookup(var.service_env, s, {})) }
  # Each secret key becomes an environment variable of the same name, read from the service's JSON secret.
  secrets = { for s in local.services : s => [for k in local.secret_keys[s] : { name = k, valueFrom = "${aws_secretsmanager_secret.service[s].arn}:${k}::" }] }
  logs = { for s in concat(local.services, ["proxy"]) : s => {
    logDriver = "awslogs"
    options   = { awslogs-group = aws_cloudwatch_log_group.service[s].name, awslogs-region = var.region, awslogs-stream-prefix = s }
  } }
  runtime_modes = { paper = "runtime", live = "runtime-live" }
  tmp_volume    = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
  container = { for s in ["api", "control", "executor", "migrate"] : s => {
    name                   = s
    image                  = local.image
    command                = [s]
    essential              = true
    readonlyRootFilesystem = true
    mountPoints            = local.tmp_volume
    environment            = [for k, v in local.env[s] : { name = k, value = v }]
    secrets                = local.secrets[s]
    logConfiguration       = local.logs[s]
    portMappings           = contains(["api", "control", "executor"], s) ? [{ containerPort = local.ports[s], protocol = "tcp" }] : []
    stopTimeout            = 30
  } }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.container
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_sizes[each.key].cpu
  memory                   = var.task_sizes[each.key].memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([each.value])
}

# Runtime worker: the runtime itself (no secrets, no AWS credentials, clean environment) plus the workload proxy
# that holds the workload secret and is its only route to the control API and executor.
resource "aws_ecs_task_definition" "runtime" {
  for_each                 = local.runtime_modes
  family                   = "${local.name}-${each.value}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_sizes.runtime.cpu
  memory                   = var.task_sizes.runtime.memory
  execution_role_arn       = aws_iam_role.execution["runtime"].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([
    {
      name                   = "proxy"
      image                  = local.image
      command                = ["proxy"]
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_volume
      environment = [
        { name = "CONTROL_UPSTREAM", value = local.internal.control },
        { name = "EXECUTOR_UPSTREAM", value = local.internal.executor },
      ]
      secrets          = local.secrets.runtime
      logConfiguration = local.logs.proxy
    },
    {
      name                   = "runtime"
      image                  = local.image
      command                = ["runtime"]
      essential              = true
      readonlyRootFilesystem = true
      mountPoints            = local.tmp_volume
      dependsOn              = [{ containerName = "proxy", condition = "START" }]
      environment            = [for k, v in merge(local.env.runtime, { RUNTIME_MODE = each.key }) : { name = k, value = v }]
      logConfiguration       = local.logs.runtime
      stopTimeout            = 60
    },
  ])
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.service["api"].arn
  desired_count                     = var.desired_counts.api
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.ports.api
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "internal" {
  for_each        = { control = aws_security_group.control.id, executor = aws_security_group.executor.id }
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = var.desired_counts[each.key]
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [each.value]
    assign_public_ip = true # outbound HTTPS only; no ingress except from runtime tasks
  }
  service_registries {
    registry_arn = aws_service_discovery_service.internal[each.key].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# Runtimes are per mode (an assignment for the other mode is refused): "runtime" serves paper, "runtime-live" live.
resource "aws_ecs_service" "runtime" {
  for_each        = local.runtime_modes
  name            = each.value
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.runtime[each.key].arn
  desired_count   = each.key == "live" ? var.desired_counts.runtime_live : var.desired_counts.runtime
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.runtime.id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_vpc_endpoint.interface, aws_vpc_endpoint.s3]
}
