variable "aws_profile" {
  description = "AWS CLI profile used for every call."
  type        = string
  default     = "monad-hack"
}

variable "region" {
  description = "Single region for the whole stack."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Name prefix and project tag (teardown verifies by this tag)."
  type        = string
  default     = "monad-hack"
}

variable "env" {
  description = "Environment tag."
  type        = string
  default     = "demo"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "public_origin" {
  description = "The studio's public https origin (the Vercel URL, or your custom domain). The hosted API accepts mutations only from it and sets session cookies for it."
  type        = string
  validation {
    condition     = can(regex("^https://[^/]+$", var.public_origin))
    error_message = "public_origin must be a bare https:// origin with no path."
  }
}

variable "image_tag" {
  description = "Image tag in ECR to run (infra/scripts/build-push.sh tags by git sha). deploy.sh rolls services to a new tag."
  type        = string
  default     = "bootstrap"
}

variable "runtime_image_digest" {
  description = "0x-prefixed SHA-256 that deployments pin and runtimes must match (the pushed image digest; build-push.sh prints it)."
  type        = string
  default     = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
  validation {
    condition     = can(regex("^0x[0-9a-f]{64}$", var.runtime_image_digest))
    error_message = "runtime_image_digest must be 0x followed by 64 lower-case hex characters."
  }
}

variable "desired_counts" {
  description = "Running tasks per service. Runtime workers each serve assignments from the control API."
  type = object({
    api          = number
    control      = number
    executor     = number
    runtime      = number
    runtime_live = number
  })
  default = { api = 1, control = 1, executor = 1, runtime = 2, runtime_live = 1 }
}

variable "task_sizes" {
  description = "Fargate cpu units / memory MiB per service."
  type        = map(object({ cpu = number, memory = number }))
  default = {
    api      = { cpu = 512, memory = 1024 }
    control  = { cpu = 512, memory = 1024 }
    executor = { cpu = 256, memory = 512 }
    runtime  = { cpu = 256, memory = 512 }
    migrate  = { cpu = 256, memory = 512 }
  }
}

variable "service_env" {
  description = "Extra non-secret environment per service, e.g. { api = { CUSTODY_PROVIDER = \"privy\", CUSTODY_CHAIN_ID = \"143\" } }. Secrets go in Secrets Manager (infra/secret-keys.json), never here."
  type        = map(map(string))
  default     = {}
}

variable "db_instance_type" {
  description = "Self-hosted Postgres 17 instance (ARM64)."
  type        = string
  default     = "t4g.small"
}

variable "db_volume_gb" {
  description = "Encrypted gp3 data volume for Postgres (kept across instance replacement)."
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  description = "Days nightly pg_dump files stay in the backup bucket."
  type        = number
  default     = 14
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "endpoint_az_count" {
  description = "Availability zones that host the private interface endpoints (each endpoint costs per AZ-hour). 1 is enough for the demo; runtime tasks in the other AZ reach them across AZs."
  type        = number
  default     = 1
}

variable "allow_destroy_with_data" {
  description = "When true, terraform destroy also deletes a non-empty backup bucket and ECR images. Keep false until you have decided to drop the data (see docs/hosting/TEARDOWN.md)."
  type        = bool
  default     = false
}

variable "custom_domain" {
  description = "Optional API hostname (e.g. api.example.com) served by CloudFront with an ACM certificate. Empty uses the *.cloudfront.net name."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Public hosted zone for custom_domain (required when custom_domain is set)."
  type        = string
  default     = ""
}
