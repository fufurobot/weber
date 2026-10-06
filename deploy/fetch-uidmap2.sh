#!/bin/bash
# uidmap lives in universe, not main. Search all components for the stanza.
set -uo pipefail

BASE="http://mirrors.tencentyun.com/ubuntu"
FOUND=""

for suite in focal focal-updates focal-security; do
  for comp in universe main; do
    IDX="$BASE/dists/$suite/$comp/binary-amd64/Packages.gz"
    code=$(curl -s -m 90 -o /tmp/P.gz -w '%{http_code}' "$IDX")
    [ "$code" != "200" ] && { echo "  $suite/$comp: http=$code"; continue; }
    gunzip -c /tmp/P.gz > /tmp/P 2>/dev/null || continue
    F=$(awk '/^Package: uidmap$/,/^$/' /tmp/P | grep -m1 '^Filename:' | awk '{print $2}')
    echo "  $suite/$comp: uidmap filename=${F:-<not here>}"
    if [ -n "$F" ] && [ -z "$FOUND" ]; then FOUND="$F"; fi
  done
done

echo
if [ -z "$FOUND" ]; then
  echo "uidmap not found in any component; searching for any package providing newuidmap"
  echo "(shadow provides it as a separate binary package only)"
  exit 1
fi

echo "=== downloading $BASE/$FOUND ==="
curl -s -m 120 -o /tmp/uidmap.deb -w "http=%{http_code} size=%{size_download}\n" "$BASE/$FOUND"
head -c 4 /tmp/uidmap.deb | od -c | head -1

echo "=== extract ==="
rm -rf /tmp/uidmap-x && mkdir -p /tmp/uidmap-x
dpkg-deb -x /tmp/uidmap.deb /tmp/uidmap-x 2>&1 | head -2
find /tmp/uidmap-x -type f 2>/dev/null | head -10

B=$(find /tmp/uidmap-x -name newuidmap 2>/dev/null | head -1)
G=$(find /tmp/uidmap-x -name newgidmap 2>/dev/null | head -1)
if [ -n "$B" ]; then
  mkdir -p "$HOME/.local/bin"
  cp "$B" "$HOME/.local/bin/newuidmap"
  [ -n "$G" ] && cp "$G" "$HOME/.local/bin/newgidmap"
  chmod 755 "$HOME/.local/bin/newuidmap"
  [ -n "$G" ] && chmod 755 "$HOME/.local/bin/newgidmap"
  echo "--- installed ---"
  ls -l "$HOME/.local/bin/newuidmap" "$HOME/.local/bin/newgidmap" 2>/dev/null
  echo "--- running it (no setuid) ---"
  "$HOME/.local/bin/newuidmap" 2>&1 | head -3
fi
