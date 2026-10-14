output "static_ip" {
  value = aws_lightsail_static_ip.app.ip_address
}

output "api_host" {
  description = "HTTPS hostname for the API (sslip.io resolves it to the static IP; Caddy gets a Let's Encrypt certificate)."
  value       = "${replace(aws_lightsail_static_ip.app.ip_address, ".", "-")}.sslip.io"
}

output "ssh" {
  value = "ssh ubuntu@${aws_lightsail_static_ip.app.ip_address}"
}
