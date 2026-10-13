terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.68.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }
  # Local state by default (terraform.tfstate is git-ignored). For a shared team state, copy
  # backend.s3.tf.example to backend.tf after creating the bucket (see docs/hosting/README.md).
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = local.tags
  }
}

# CloudFront certificates for a custom domain must live in us-east-1.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile
  default_tags {
    tags = local.tags
  }
}
