# ═══════════════════════════════════════════════════════════
# Security Groups
# ═══════════════════════════════════════════════════════════

resource "aws_security_group" "ec2" {
  name_prefix = "${var.project_name}-ec2-"
  description = "Security group for HackEval EC2 instance"
  vpc_id      = aws_vpc.main.id

  # SSH access (only if key pair is configured)
  dynamic "ingress" {
    for_each = var.key_pair_name != "" ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.allowed_ssh_cidr]
    }
  }

  # The app port is reachable ONLY from the ALB security group. The ALB
  # terminates TLS and is the public entry point; never expose 3000 to the
  # internet directly (it bypasses the ALB's listener rules and TLS).
  ingress {
    description     = "HTTP from ALB"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.project_name}-ec2-sg" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-alb-"
  description = "Security group for HackEval ALB"
  vpc_id      = aws_vpc.main.id

  # HTTP
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  dynamic "ingress" {
    for_each = var.enable_https ? [1] : []
    content {
      description = "HTTPS"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.project_name}-alb-sg" })

  lifecycle {
    create_before_destroy = true
  }
}
