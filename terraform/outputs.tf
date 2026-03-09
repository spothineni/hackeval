# ═══════════════════════════════════════════════════════════
# Outputs
# ═══════════════════════════════════════════════════════════

output "app_url" {
  description = "Application URL (ALB DNS name or custom domain)"
  value       = var.domain_name != "" ? (var.enable_https ? "https://${var.domain_name}" : "http://${var.domain_name}") : "http://${aws_lb.app.dns_name}"
}

output "alb_dns_name" {
  description = "ALB DNS name — use this URL if no custom domain"
  value       = "http://${aws_lb.app.dns_name}"
}

output "ec2_public_ip" {
  description = "EC2 Elastic IP address"
  value       = aws_eip.app.public_ip
}

output "ec2_direct_url" {
  description = "Direct EC2 access (bypasses ALB)"
  value       = "http://${aws_eip.app.public_ip}:3000"
}

output "ec2_instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "ssm_connect_command" {
  description = "Connect to EC2 via SSM Session Manager (no SSH key needed)"
  value       = "aws ssm start-session --target ${aws_instance.app.id}"
}

output "ssh_command" {
  description = "SSH command (only if key_pair_name was set)"
  value       = var.key_pair_name != "" ? "ssh -i ~/.ssh/${var.key_pair_name}.pem ec2-user@${aws_eip.app.public_ip}" : "N/A — use SSM: aws ssm start-session --target ${aws_instance.app.id}"
}

output "nameservers" {
  description = "Nameservers (only if a new hosted zone was created)"
  value       = var.domain_name != "" && var.hosted_zone_name == "" ? aws_route53_zone.new[0].name_servers : []
}
