# One execution role per service (pull the image, write logs, read only that service's secret) and one task
# role per service. Runtime tasks get no task role at all: no AWS credentials inside the runtime.
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = toset(local.services)
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret" {
  for_each = aws_iam_role.execution
  name     = "read-own-secret"
  role     = each.value.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.service[each.key].arn }]
  })
}

# Task roles: no AWS permissions are needed by the application today (it talks to Postgres, RPC and providers
# over the network). api/control/executor get an empty role so ECS Exec or future scoped grants attach per service.
resource "aws_iam_role" "task" {
  for_each           = toset(["api", "control", "executor", "migrate"])
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
