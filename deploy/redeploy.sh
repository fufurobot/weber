#!/bin/bash
# Redeploy Weber on this host: pull, install, build, restart.
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
APP="$HOME/weber"

echo "=== pull ==="
cd "$APP"
git fetch --depth 1 origin main -q
git reset --hard origin/main -q
git log --oneline -1

echo
echo "=== dependencies ==="
bun install --frozen-lockfile 2>/dev/null | tail -2 || bun install | tail -2

echo
echo "=== build frontend ==="
bun run build:web | tail -4

echo
echo "=== restart service ==="
systemctl --user restart weber.service
sleep 4
systemctl --user is-active weber.service

echo
echo "=== probe ==="
echo -n "GET /          -> "; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -m 10 http://127.0.0.1:8080/
echo -n "GET /api/health-> "; curl -s -m 10 http://127.0.0.1:8080/api/health; echo
echo -n "GET /api/tools -> "; curl -s -m 20 http://127.0.0.1:8080/api/tools | head -c 200; echo
echo -n "asset          -> "; A=$(curl -s -m 10 http://127.0.0.1:8080/ | grep -o 'assets/[^"]*\.js' | head -1); echo "$A"; curl -s -o /dev/null -w "  %{http_code} %{content_type}\n" -m 10 "http://127.0.0.1:8080/$A"
echo -n "unknown api    -> "; curl -s -o /dev/null -w '%{http_code}\n' -m 10 http://127.0.0.1:8080/api/nope
