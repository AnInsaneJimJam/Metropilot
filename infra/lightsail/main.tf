# One Lightsail server running the whole backend in Docker (docs/hosting/LIGHTSAIL.md): Caddy (HTTPS), API, control,
# executor, paper and live runtimes, Postgres. Lightsail is outside the organization SCP that blocks EC2/ECS here.
resource "aws_lightsail_key_pair" "ops" {
  name       = "${var.name}-ops"
  public_key = var.ssh_public_key
}

resource "aws_lightsail_instance" "app" {
  name              = var.name
  availability_zone = var.availability_zone
  blueprint_id      = "ubuntu_24_04"
  bundle_id         = var.bundle_id
  key_pair_name     = aws_lightsail_key_pair.ops.name
  user_data         = file("${path.module}/user-data.sh")

  # Daily automatic snapshots (kept 7 days by Lightsail): the server-level backup next to the nightly pg_dump.
  add_on {
    type          = "AutoSnapshot"
    snapshot_time = "06:00"
    status        = "Enabled"
  }
}

resource "aws_lightsail_static_ip" "app" {
  name = "${var.name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "app" {
  static_ip_name = aws_lightsail_static_ip.app.name
  instance_name  = aws_lightsail_instance.app.name
}

# Only HTTPS (and HTTP for the certificate challenge and redirect) are public; SSH from the operator's address.
resource "aws_lightsail_instance_public_ports" "app" {
  instance_name = aws_lightsail_instance.app.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
    cidrs     = ["0.0.0.0/0"]
  }
  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
    cidrs     = ["0.0.0.0/0"]
  }
  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.ssh_cidrs
  }
}
