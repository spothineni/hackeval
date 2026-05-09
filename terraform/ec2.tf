# ═══════════════════════════════════════════════════════════
# EC2 Instance
# ═══════════════════════════════════════════════════════════

resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.instance_type
  key_name               = var.key_pair_name != "" ? var.key_pair_name : null
  subnet_id              = aws_subnet.public_a.id
  vpc_security_group_ids = [aws_security_group.ec2.id]

  # NOTE: keep var.ssm_param_prefix in sync with the SSM_PREFIX default
  # inside userdata.sh. Using `templatefile()` would let Terraform inject it
  # but would force every `${BASH_VAR}` in the script to be escaped — too
  # noisy for the trade-off.
  user_data = file("${path.module}/userdata.sh")

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    delete_on_termination = true
  }

  # IAM role for Bedrock access
  iam_instance_profile = aws_iam_instance_profile.ec2.name

  tags = merge(var.tags, { Name = "${var.project_name}-server" })
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = merge(var.tags, { Name = "${var.project_name}-eip" })
}

# ─── IAM Role (for Bedrock AI access) ────────────────────
resource "aws_iam_role" "ec2" {
  name = "${var.project_name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "bedrock_access" {
  name = "${var.project_name}-bedrock-policy"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ]
      Resource = "arn:aws:bedrock:*::foundation-model/*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.project_name}-ec2-profile"
  role = aws_iam_role.ec2.name
  tags = var.tags
}

# SSM Session Manager access (no SSH key needed). This managed policy covers
# the agent's session/registration calls but does NOT include
# ssm:GetParameter — that's a separate scoped policy below.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Read app secrets at boot. Scoped to one prefix so a compromised instance
# can't enumerate other apps' parameters in the account.
data "aws_caller_identity" "current" {}

# Read/write/delete objects in the upload bucket. Conditional on
# var.storage_bucket — if empty, no policy is created (the app falls back to
# local-disk storage, which is not durable on EC2 either; production
# operators should ALWAYS set this).
resource "aws_iam_role_policy" "s3_upload_access" {
  count = var.storage_bucket != "" ? 1 : 0
  name  = "${var.project_name}-s3-uploads"
  role  = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Object-level: get/put/delete only on objects in this bucket.
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "arn:aws:s3:::${var.storage_bucket}/*"
      },
      {
        # Bucket-level: list is occasionally needed by the SDK (e.g. to
        # confirm the bucket exists). Scoped to this one bucket.
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = "arn:aws:s3:::${var.storage_bucket}"
      }
    ]
  })
}

resource "aws_iam_role_policy" "ssm_param_read" {
  name = "${var.project_name}-ssm-param-read"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_param_prefix}/*"
      }],
      # SecureStrings need kms:Decrypt against the encrypting key. If the
      # operator hasn't provided a custom CMK we still need to allow the
      # AWS-managed key (alias/aws/ssm); we restrict by ViaService context
      # rather than ARN since that key's ARN varies per account/region.
      [
        var.ssm_kms_key_arn != "" ? {
          Effect   = "Allow"
          Action   = ["kms:Decrypt"]
          Resource = var.ssm_kms_key_arn
        } : {
          Effect   = "Allow"
          Action   = ["kms:Decrypt"]
          Resource = "*"
          Condition = {
            StringEquals = {
              "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
            }
          }
        }
      ]
    )
  })
}

# ═══════════════════════════════════════════════════════════
# Application Load Balancer
# ═══════════════════════════════════════════════════════════

resource "aws_lb" "app" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]

  tags = merge(var.tags, { Name = "${var.project_name}-alb" })
}

resource "aws_lb_target_group" "app" {
  name     = "${var.project_name}-tg"
  port     = var.app_port
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/api/settings"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200,401"
  }

  tags = var.tags
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = var.app_port
}

# HTTP listener — redirects to HTTPS if enabled, otherwise forwards to app
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.enable_https ? "redirect" : "forward"

    dynamic "redirect" {
      for_each = var.enable_https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    target_group_arn = var.enable_https ? null : aws_lb_target_group.app.arn
  }
}

# HTTPS listener (only if enabled)
resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate_validation.cert[0].certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
