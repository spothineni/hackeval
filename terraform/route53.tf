# ═══════════════════════════════════════════════════════════
# Route53 DNS
# ═══════════════════════════════════════════════════════════

# Look up existing hosted zone OR create a new one
data "aws_route53_zone" "existing" {
  count = var.hosted_zone_name != "" ? 1 : 0
  name  = var.hosted_zone_name
}

resource "aws_route53_zone" "new" {
  count = var.hosted_zone_name == "" ? 1 : 0
  name  = var.domain_name

  tags = merge(var.tags, { Name = "${var.project_name}-zone" })
}

locals {
  zone_id = var.hosted_zone_name != "" ? data.aws_route53_zone.existing[0].zone_id : aws_route53_zone.new[0].zone_id
}

# A record pointing to ALB
resource "aws_route53_record" "app" {
  zone_id = local.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}

# ═══════════════════════════════════════════════════════════
# ACM Certificate (HTTPS)
# ═══════════════════════════════════════════════════════════

resource "aws_acm_certificate" "cert" {
  count             = var.enable_https ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  tags = merge(var.tags, { Name = "${var.project_name}-cert" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_https ? {
    for dvo in aws_acm_certificate.cert[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = local.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cert" {
  count                   = var.enable_https ? 1 : 0
  certificate_arn         = aws_acm_certificate.cert[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
