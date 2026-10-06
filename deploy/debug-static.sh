#!/bin/bash
# Debug why static serving returns 404 despite dist/web existing.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

echo "=== what WEBER_WEB_ROOT does the service have? ==="
systemctl --user show weber.service -p Environment | tr ' ' '\n' | grep -i weber || echo "(none)"

echo
echo "=== the value main.ts would compute without the override ==="
# import.meta.dir is <app>/src/server, so ../../dist/web is <app>/dist/web
echo "app dist/web: $HOME/weber/dist/web"
ls -la "$HOME/weber/dist/web/" | head -6

echo
echo "=== does the running process see the override? ==="
PID=$(systemctl --user show weber.service -p MainPID --value)
echo "main pid: $PID"
tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null | grep -iE 'WEBER_WEB_ROOT|^PATH=' | head -5

echo
echo "=== probe the running service directly ==="
curl -s -i -m 10 http://127.0.0.1:8080/ | head -8

echo
echo "=== service log ==="
journalctl --user -u weber.service -n 15 --no-pager 2>/dev/null | tail -15
