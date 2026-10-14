terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.68.0"
    }
  }
}

provider "aws" {
  profile = var.aws_profile
  region  = var.region
  default_tags {
    tags = { project = "monad-hack", env = "lightsail" }
  }
}
