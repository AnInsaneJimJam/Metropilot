variable "aws_profile" {
  type    = string
  default = "monad-hack"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "availability_zone" {
  type    = string
  default = "us-east-1a"
}

variable "name" {
  description = "Instance and resource name prefix."
  type        = string
  default     = "metropilot"
}

variable "bundle_id" {
  description = "Lightsail plan: medium_3_0 is 2 vCPU, 4 GB RAM, 80 GB SSD (USD 24/month)."
  type        = string
  default     = "medium_3_0"
}

variable "ssh_public_key" {
  description = "Public key for the ubuntu user (the private key never leaves your machine)."
  type        = string
}

variable "ssh_cidrs" {
  description = "Addresses allowed to SSH (your IP as a /32). Ports 80/443 are open to all."
  type        = list(string)
}
