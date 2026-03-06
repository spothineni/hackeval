# ═══════════════════════════════════════════════════════════
# Outputs
# ═══════════════════════════════════════════════════════════

output "app_url" {
  description = "Application URL"
  value       = var.enable_https ? "https://${var.domain_name}" : "http://${var.domain_name}"
}

output "alb_dns_name" {
  description = "ALB DNS name (for CNAME if using external DNS)"
  value       = aws_lb.app.dns_name
}

output "ec2_public_ip" {
  description = "EC2 Elastic IP address"
  value       = aws_eip.app.public_ip
}

output "ec2_instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "ssh_command" {
  description = "SSH command to connect to the server"
  value       = "ssh -i ~/.ssh/${var.key_pair_name}.pem ec2-user@${aws_eip.app.public_ip}"
}

output "nameservers" {
  description = "Nameservers (only if a new hosted zone was created)"
  value       = var.hosted_zone_name == "" ? aws_route53_zone.new[0].name_servers : []
}
