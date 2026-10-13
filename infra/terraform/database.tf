# Self-hosted Postgres 17 on one ARM64 instance (no RDS). Data lives on a separate encrypted gp3 volume that
# survives instance replacement. No SSH: Session Manager only. Nightly pg_dump goes to the backup bucket.
data "aws_ssm_parameter" "ubuntu_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_s3_bucket" "backups" {
  bucket_prefix = "${local.name}-pg-backups-"
  force_destroy = var.allow_destroy_with_data
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-dumps"
    status = "Enabled"
    filter {
      prefix = "pg/"
    }
    expiration {
      days = var.backup_retention_days
    }
  }
}

resource "aws_iam_role" "db" {
  name = "${local.name}-db"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "db_ssm" {
  role       = aws_iam_role.db.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "db" {
  name = "db-secret-and-backups"
  role = aws_iam_role.db.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.service["db"].arn },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"], Resource = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"] },
    ]
  })
}

resource "aws_iam_instance_profile" "db" {
  name = "${local.name}-db"
  role = aws_iam_role.db.name
}

resource "aws_ebs_volume" "pgdata" {
  availability_zone = local.azs[0]
  size              = var.db_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.name}-pgdata" }
}

resource "aws_instance" "db" {
  ami                         = data.aws_ssm_parameter.ubuntu_arm64.value
  instance_type               = var.db_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.db.id]
  iam_instance_profile        = aws_iam_instance_profile.db.name
  associate_public_ip_address = true # outbound only (apt, S3, Secrets Manager, SSM); no inbound rule but 5432 from app groups
  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_type = "gp3"
    volume_size = 10
    encrypted   = true
  }
  user_data_replace_on_change = false
  user_data = templatefile("${path.module}/templates/db-init.sh.tftpl", {
    region        = var.region
    secret_id     = aws_secretsmanager_secret.service["db"].arn
    volume_id     = aws_ebs_volume.pgdata.id
    vpc_cidr      = var.vpc_cidr
    backup_bucket = aws_s3_bucket.backups.id
    db_name       = "monad"
    db_user       = "monad"
  })
  tags = { Name = "${local.name}-postgres" }
  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "pgdata" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.pgdata.id
  instance_id = aws_instance.db.id
}

# db.monad.internal → the instance's private address, for every service's DATABASE_URL.
resource "aws_service_discovery_instance" "db" {
  instance_id = "postgres"
  service_id  = aws_service_discovery_service.internal["db"].id
  attributes = {
    AWS_INSTANCE_IPV4 = aws_instance.db.private_ip
  }
}
