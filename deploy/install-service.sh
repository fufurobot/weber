#!/bin/bash
# Install Weber as a user-level systemd service on the host.
#
# No sudo: `systemctl --user` works because the user session is running, and
# lingering can be enabled later by an administrator if the service must
# survive logout. Bound to loopback and reached over an SSH tunnel, because
# Tencent Cloud's firewall is not under this account's control.
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
APP="$HOME/weber"
UNIT_DIR="$HOME/.config/systemd/user"
PORT="${WEBER_PORT:-8080}"
ENV_FILE="$HOME/.weber.env"

echo "=== 1. environment file ==="
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 43)
  cat > "$ENV_FILE" <<EOF
# Weber runtime configuration. Keep this file private (chmod 600).
CORE_HOST=127.0.0.1
CORE_PORT=$PORT
WORKSPACE_ROOT=$HOME/weber-workspaces
WEBER_VERSION=0.1.0

# --- authentication -------------------------------------------------------
# Off unless GITHUB_CLIENT_ID and WEBER_ALLOWED_LOGINS are both set.
# Create an OAuth app at https://github.com/settings/developers with the
# "Device flow" option enabled, then fill these in.
GITHUB_CLIENT_ID=
WEBER_ALLOWED_LOGINS=fufurobot
WEBER_SESSION_SECRET=$SECRET
EOF
  chmod 600 "$ENV_FILE"
  echo "created $ENV_FILE (mode 600)"
else
  echo "keeping existing $ENV_FILE"
fi

echo
echo "=== 2. systemd user unit ==="
# Always rewritten: the unit is deployment configuration that we own, and
# guarding it on "already exists" silently keeps a stale PATH across upgrades.
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/weber.service" <<EOF
[Unit]
Description=Weber portable IDE (core service)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
# systemd gives a minimal PATH, so the toolchains Weber advertises would all
# probe as "not installed". Put the runtime directories back.
Environment=PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=WEBER_WEB_ROOT=$APP/dist/web
ExecStart=$HOME/.bun/bin/bun run $APP/src/server/main.ts
Restart=on-failure
RestartSec=5
# Keep the service from being killed for using memory a build legitimately needs.
MemoryMax=1200M

[Install]
WantedBy=default.target
EOF

echo "wrote $UNIT_DIR/weber.service"

echo
echo "=== 3. reload and start ==="
systemctl --user daemon-reload
systemctl --user enable weber.service 2>&1 | head -2 || true
systemctl --user restart weber.service
sleep 4
systemctl --user is-active weber.service || true

echo
echo "=== 4. status ==="
systemctl --user status weber.service --no-pager 2>&1 | head -14

echo
echo "=== 5. probe the API ==="
curl -s -m 10 "http://127.0.0.1:$PORT/api/health" || echo "(health probe failed)"
echo
curl -s -m 10 "http://127.0.0.1:$PORT/api/auth/status" || echo "(auth status failed)"
echo
