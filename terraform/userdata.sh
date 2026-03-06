#!/bin/bash
# ═══════════════════════════════════════════════════════════
# HackEval — EC2 Bootstrap Script
# ═══════════════════════════════════════════════════════════
set -euo pipefail
exec > /var/log/hackeval-init.log 2>&1

echo "▸ Starting HackEval deployment..."

# ─── System updates ───────────────────────────────────────
dnf update -y
dnf install -y git nodejs npm

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

# ─── Create systemd service ──────────────────────────────
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
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=JWT_SECRET=$(openssl rand -hex 32)

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
