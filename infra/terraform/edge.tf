# Public edge: CloudFront (HTTPS, *.cloudfront.net or a custom domain) → ALB (HTTP, CloudFront origin-facing
# addresses only, and only with the secret origin header) → API tasks. Vercel rewrites /v1/* to the CloudFront URL.
# The origin-verify token is generated here and therefore lives in Terraform state; it only proves a request came
# through this distribution and grants no data access by itself.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_lb" "api" {
  name                       = "${local.name}-api"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 3600 # long-lived event streams
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = local.ports.api
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  # The hosted API has no health route yet; /v1/session answers 401 without a session, which proves the process
  # serves requests. Any status below 500 is healthy.
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = "{\"message\":\"Not found.\"}"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---- optional custom domain -------------------------------------------------------------------------------
resource "aws_acm_certificate" "api" {
  count             = var.custom_domain == "" ? 0 : 1
  provider          = aws.us_east_1
  domain_name       = var.custom_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_validation" {
  for_each = var.custom_domain == "" ? {} : { for o in aws_acm_certificate.api[0].domain_validation_options : o.domain_name => o }
  zone_id  = var.route53_zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 300
}

resource "aws_acm_certificate_validation" "api" {
  count                   = var.custom_domain == "" ? 0 : 1
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.api[0].arn
  validation_record_fqdns = [for r in aws_route53_record.api_validation : r.fqdn]
}

# ---- CloudFront ---------------------------------------------------------------------------------------------
locals {
  cache_disabled         = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "${local.name} API"
  price_class     = "PriceClass_100"
  http_version    = "http2"
  is_ipv6_enabled = true
  aliases         = var.custom_domain == "" ? [] : [var.custom_domain]

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.api.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60 # the event stream writes a keep-alive every ~15 s
      origin_keepalive_timeout = 60
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_disabled
    origin_request_policy_id = local.all_viewer_except_host
    compress                 = false # do not buffer server-sent events
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.custom_domain == ""
    acm_certificate_arn            = var.custom_domain == "" ? null : aws_acm_certificate_validation.api[0].certificate_arn
    ssl_support_method             = var.custom_domain == "" ? null : "sni-only"
    minimum_protocol_version       = var.custom_domain == "" ? "TLSv1" : "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "api" {
  count   = var.custom_domain == "" ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}
