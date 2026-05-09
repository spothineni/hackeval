#!/bin/bash
# ═══════════════════════════════════════════════════════════
# HackEval — EC2 Bootstrap Script
# ═══════════════════════════════════════════════════════════
set -euo pipefail
exec > /var/log/hackeval-init.log 2>&1

echo "▸ Starting HackEval deployment..."

# ─── System updates ───────────────────────────────────────
dnf update -y
dnf install -y git nodejs npm awscli jq

# ─── Create app user ──────────────────────────────────────
useradd -m -s /bin/bash hackeval || true

# ─── Clone application ───────────────────────────────────
APP_DIR="/home/hackeval/app"
if [ ! -d "$APP_DIR" ]; then
    git clone https://github.com/spothineni/hackeval.git "$APP_DIR"
else
    cd "$APP_DIR" && git pull origin main
fi

chown -R hackeval:hackeval "$APP_DIR"

# ─── Install dependencies ────────────────────────────────
cd "$APP_DIR"
sudo -u hackeval npm install --production

# ─── Create uploads directory ────────────────────────────
sudo -u hackeval mkdir -p "$APP_DIR/uploads"

# ─── Pull production secrets from AWS SSM Parameter Store ──
# Requires the EC2 instance role to have ssm:GetParameter (and kms:Decrypt
# for SecureString values). Set these parameters once per environment:
#
#   /hackeval/<env>/JWT_SECRET           SecureString
#   /hackeval/<env>/DATABASE_URL         SecureString
#   /hackeval/<env>/STORAGE_BUCKET       String   (e.g. hackeval-uploads-prod)
#   /hackeval/<env>/STORAGE_REGION       String   (default: us-east-1)
#   /hackeval/<env>/APP_URL              String   (e.g. https://app.example.com)
#   /hackeval/<env>/SMTP_HOST            String        (optional)
#   /hackeval/<env>/SMTP_USER            SecureString  (optional)
#   /hackeval/<env>/SMTP_PASS            SecureString  (optional)
#   /hackeval/<env>/OPENAI_API_KEY       SecureString  (optional)
#
# Generating JWT_SECRET inline (the previous behavior) invalidated every
# session whenever the instance was replaced — use a stored secret instead.
# Must match var.ssm_param_prefix in terraform/variables.tf — the IAM policy
# is scoped to this exact path. Override by editing both places, or by
# rebuilding the AMI with a different SSM_PREFIX baked in.
SSM_PREFIX="/hackeval/prod"
AWS_REGION_LOCAL="$(curl -fsSL --max-time 2 http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region 2>/dev/null || echo us-east-1)"

ssm_get() {
    local name="$1"
    aws ssm get-parameter --region "$AWS_REGION_LOCAL" --with-decryption \
        --name "${SSM_PREFIX}/${name}" \
        --query 'Parameter.Value' --output text 2>/dev/null || true
}

JWT_SECRET="$(ssm_get JWT_SECRET)"
DATABASE_URL="$(ssm_get DATABASE_URL)"
STORAGE_BUCKET="$(ssm_get STORAGE_BUCKET)"
STORAGE_REGION="$(ssm_get STORAGE_REGION)"
APP_URL="$(ssm_get APP_URL)"
SMTP_HOST="$(ssm_get SMTP_HOST)"
SMTP_USER="$(ssm_get SMTP_USER)"
SMTP_PASS="$(ssm_get SMTP_PASS)"
OPENAI_API_KEY="$(ssm_get OPENAI_API_KEY)"

if [ -z "$JWT_SECRET" ] || [ -z "$DATABASE_URL" ]; then
    echo "❌ Missing required SSM parameters under ${SSM_PREFIX}/. Need at minimum JWT_SECRET and DATABASE_URL." >&2
    exit 1
fi

# ─── Create systemd service ──────────────────────────────
# EnvironmentFile keeps secrets out of the unit file; root-only readable.
ENV_FILE=/etc/hackeval.env
umask 077
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=${JWT_SECRET}
DATABASE_URL=${DATABASE_URL}
STORAGE_PROVIDER=s3
STORAGE_BUCKET=${STORAGE_BUCKET}
STORAGE_REGION=${STORAGE_REGION:-us-east-1}
APP_URL=${APP_URL}
SMTP_HOST=${SMTP_HOST}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
OPENAI_API_KEY=${OPENAI_API_KEY}
EOF
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"

cat > /etc/systemd/system/hackeval.service <<EOF
[Unit]
Description=HackEval — Hackathon Evaluator
After=network.target

[Service]
Type=simple
User=hackeval
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=$ENV_FILE

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hackeval

[Install]
WantedBy=multi-user.target
EOF

# ─── Start service ────────────────────────────────────────
systemctl daemon-reload
systemctl enable hackeval
systemctl start hackeval

# ─── Verify ──────────────────────────────────────────────
sleep 3
if systemctl is-active --quiet hackeval; then
    echo "✅ HackEval is running on port 3000"
else
    echo "❌ HackEval failed to start"
    journalctl -u hackeval --no-pager -n 20
fi

echo "▸ Bootstrap complete!"
