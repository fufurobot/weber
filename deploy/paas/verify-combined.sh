#!/bin/bash
# Verify combined (single-process) mode the way a PaaS runs it.
#
# This is the check that matters for workstream 2: no nginx, one process, the
# platform's PORT, the SPA served by the core, and auth enforced.
set -uo pipefail

APP="${1:-$(pwd)}"
cd "$APP" || exit 1

echo "=== build the SPA (the core must be able to serve it) ==="
bun run build:web 2>&1 | tail -3

PORT_TO_USE="${PORT:-18080}"
WS=$(mktemp -d)
WEBROOT="$APP/dist/web"

echo
echo "=== 1. unauthenticated single-process start on PORT=$PORT_TO_USE ==="
PORT="$PORT_TO_USE" \
CORE_HOST=0.0.0.0 \
WEBER_WEB_ROOT="$WEBROOT" \
WORKSPACE_ROOT="$WS" \
WEBER_SEED=1 \
bun run src/server/main.ts > /tmp/weber-combined.log 2>&1 &
PID=$!
sleep 5

if ! kill -0 "$PID" 2>/dev/null; then
  echo "FAIL: server exited"; cat /tmp/weber-combined.log; exit 1
fi

echo "--- startup log ---"
cat /tmp/weber-combined.log

B="http://127.0.0.1:$PORT_TO_USE"
echo
echo "--- PORT was honoured (not the 8787 default) ---"
curl -s -o /dev/null -w "  /api/health -> %{http_code}\n" -m 10 "$B/api/health"

echo "--- the SPA is served by the core, with no edge ---"
curl -s -o /dev/null -w "  /            -> %{http_code} %{content_type}\n" -m 10 "$B/"
ASSET=$(curl -s -m 10 "$B/" | grep -o 'assets/[^"]*\.js' | head -1)
curl -s -o /dev/null -w "  /$ASSET -> %{http_code} %{content_type}\n" -m 10 "$B/$ASSET"

echo "--- the API works and the workspace was seeded ---"
curl -s -m 10 "$B/api/fs/list?path=" | head -c 200; echo

echo "--- unauthenticated: file access is OPEN (auth not configured) ---"
curl -s -o /dev/null -w "  expected 200 -> %{http_code}\n" -m 10 "$B/api/fs/list?path="

kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null

echo
echo "=== 2. with auth configured, the same routes must be refused ==="
PORT="$PORT_TO_USE" \
CORE_HOST=0.0.0.0 \
WEBER_WEB_ROOT="$WEBROOT" \
WORKSPACE_ROOT="$WS" \
GITHUB_CLIENT_ID="Iv1.combined-test" \
WEBER_ALLOWED_LOGINS="someone" \
WEBER_SESSION_SECRET="a-sufficiently-long-session-secret" \
bun run src/server/main.ts > /tmp/weber-auth.log 2>&1 &
PID=$!
sleep 5

echo "--- startup log (must NOT contain the unauthenticated warning) ---"
cat /tmp/weber-auth.log
if grep -q "WITHOUT authentication" /tmp/weber-auth.log; then
  echo "FAIL: warned about missing auth despite it being configured"
else
  echo "ok: no unauthenticated warning"
fi

echo
echo "--- auth status ---"
curl -s -m 10 "$B/api/auth/status"; echo
echo "--- file access must be 401 ---"
curl -s -o /dev/null -w "  /api/fs/list -> %{http_code}\n" -m 10 "$B/api/fs/list?path="
echo "--- health must stay public for the platform's healthcheck ---"
curl -s -o /dev/null -w "  /api/health  -> %{http_code}\n" -m 10 "$B/api/health"
echo "--- the SPA shell must stay public, or the login page cannot load ---"
curl -s -o /dev/null -w "  /            -> %{http_code}\n" -m 10 "$B/"

kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
rm -rf "$WS"
echo
echo "=== done ==="
