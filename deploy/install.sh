#!/usr/bin/env bash
set -euo pipefail

# Wood Fired Bugs - Deployment Setup
# Run as root or with sudo: sudo bash deploy/install.sh
#
# Prerequisites:
#   - Node.js installed at /usr/bin/node
#   - Project built (npm run build)
#   - sqlite3 CLI installed (sudo apt-get install sqlite3)
#
# What this script does:
#   1. Creates /opt/wood-fired-bugs directory structure
#   2. Copies built application files
#   3. Installs production dependencies
#   4. Copies systemd unit file
#   5. Enables and starts the service
#
# After running, you MUST:
#   - Edit /opt/wood-fired-bugs/.env to set real API_KEYS
#   - Run: sudo systemctl restart wood-fired-bugs

INSTALL_DIR="/opt/wood-fired-bugs"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="stuart"

echo "=== Wood Fired Bugs Deployment ==="

# Create directory structure
mkdir -p "$INSTALL_DIR"/{data,backups,dist}

# Copy application files
cp -r "$SOURCE_DIR/dist/"* "$INSTALL_DIR/dist/"
cp "$SOURCE_DIR/package.json" "$INSTALL_DIR/"
cp "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/" 2>/dev/null || true

# Install production dependencies only
cd "$INSTALL_DIR"
npm install --omit=dev

# Copy env template if .env doesn't exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$SOURCE_DIR/deploy/wood-fired-bugs.env.example" "$INSTALL_DIR/.env"
  echo "WARNING: Created .env from template. Edit $INSTALL_DIR/.env to set API_KEYS before starting."
fi

# Set ownership
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# Install systemd unit
cp "$SOURCE_DIR/deploy/wood-fired-bugs.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable wood-fired-bugs

echo ""
echo "=== Deployment Complete ==="
echo "Next steps:"
echo "  1. Edit $INSTALL_DIR/.env (set API_KEYS)"
echo "  2. sudo systemctl start wood-fired-bugs"
echo "  3. sudo systemctl status wood-fired-bugs"
echo "  4. sudo journalctl -u wood-fired-bugs -f"
