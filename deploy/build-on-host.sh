#!/bin/bash
# Deploy Weber to the host using the Bun already installed there.
#
# Rootless podman is impossible here: newuidmap needs setuid root for the
# multi-ID mapping that /etc/subuid implies, and an unprivileged user cannot set
# that bit. Rootless docker would hit the same wall via rootlesskit. So the
# service runs directly on Bun, which is already present at ~/.bun/bin/bun.
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
APP="$HOME/weber"
REPO="${WEBER_REPO:-https://github.com/fufurobot/weber.git}"

echo "=== 1. fetch the source ==="
if [ -d "$APP/.git" ]; then
  echo "existing checkout; updating"
  git -C "$APP" fetch --depth 1 origin main
  git -C "$APP" reset --hard origin/main
else
  git clone --depth 1 "$REPO" "$APP"
fi
git -C "$APP" log --oneline -1

echo
echo "=== 2. install dependencies ==="
cd "$APP"
bun install --frozen-lockfile 2>/dev/null || bun install

echo
echo "=== 3. build the frontend ==="
bun run build:web

echo
echo "=== 4. verify the build ==="
test -f dist/web/index.html && echo "ok index.html"
ls dist/web/assets/*.js >/dev/null && echo "ok js asset"
ls dist/web/assets/*.css >/dev/null && echo "ok css asset"

echo
echo "=== 5. run the test suite on the host ==="
bun test 2>&1 | tail -6

echo
echo "=== done ==="
echo "app at $APP"
echo "bun at $(command -v bun)"
