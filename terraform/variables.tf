variable "aws_region" {
  description = "AWS region to deploy in"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "hackeval"
}

variable "domain_name" {
  description = "Domain name for the application (e.g. hackeval.example.com)"
  type        = string
}

variable "hosted_zone_name" {
  description = "Route53 hosted zone name (e.g. example.com). Leave empty to create a new hosted zone."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "key_pair_name" {
  description = "Name of the EC2 key pair for SSH access"
  type        = string
}

variable "app_port" {
  description = "Port the Node.js app runs on"
  type        = number
  default     = 3000
}

variable "enable_https" {
  description = "Enable HTTPS with ACM certificate and ALB"
  type        = bool
  default     = true
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into EC2 (default: open, restrict for production)"
  type        = string
  default     = "0.0.0.0/0"
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    Project     = "HackEval"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}
