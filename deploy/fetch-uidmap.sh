#!/bin/bash
# Fetch uidmap from the mirror this host is actually configured to use.
set -uo pipefail

BASE="http://mirrors.tencentyun.com/ubuntu"
SUITE="focal-updates"
COMP="main"

echo "=== resolve the exact uidmap filename from the package index ==="
# The pool path includes the version, so read it from the index rather than guessing.
IDX="$BASE/dists/$SUITE/$COMP/binary-amd64/Packages.gz"
echo "index: $IDX"
code=$(curl -s -m 60 -o /tmp/Packages.gz -w '%{http_code}' "$IDX")
echo "index http=$code size=$(stat -c %s /tmp/Packages.gz 2>/dev/null || echo 0)"

if [ "$code" = "200" ]; then
  gunzip -c /tmp/Packages.gz > /tmp/Packages 2>/dev/null || cp /tmp/Packages.gz /tmp/Packages
  echo "--- searching for the uidmap stanza ---"
  awk '/^Package: uidmap$/,/^$/' /tmp/Packages | head -20
  FILENAME=$(awk '/^Package: uidmap$/,/^$/' /tmp/Packages | grep -m1 '^Filename:' | awk '{print $2}')
  echo "filename: ${FILENAME:-<none>}"
  if [ -n "${FILENAME:-}" ]; then
    echo "=== downloading $BASE/$FILENAME ==="
    curl -s -m 120 -o /tmp/uidmap.deb -w "http=%{http_code} size=%{size_download}\n" "$BASE/$FILENAME"
  fi
fi

echo
echo "=== extract and inspect without root ==="
if [ -s /tmp/uidmap.deb ] && file /tmp/uidmap.deb 2>/dev/null | grep -qi debian; then
  rm -rf /tmp/uidmap-x && mkdir -p /tmp/uidmap-x
  dpkg-deb -x /tmp/uidmap.deb /tmp/uidmap-x 2>&1 | head -2
  find /tmp/uidmap-x -type f | head -10
  B=$(find /tmp/uidmap-x -name newuidmap | head -1)
  if [ -n "$B" ]; then
    mkdir -p "$HOME/.local/bin"
    cp "$B" "$HOME/.local/bin/newuidmap"
    cp "$(find /tmp/uidmap-x -name newgidmap | head -1)" "$HOME/.local/bin/newgidmap"
    chmod 755 "$HOME/.local/bin/newuidmap" "$HOME/.local/bin/newgidmap"
    echo "installed (no setuid):"
    ls -l "$HOME/.local/bin/newuidmap" "$HOME/.local/bin/newgidmap"
  fi
else
  echo "no valid deb downloaded"
fi

echo
echo "=== does a non-setuid newuidmap work? ==="
export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1
newuidmap 2>&1 | head -3
echo "--- podman now? ---"
podman info --format '{{.Host.Security.Rootless}}' 2>&1 | tail -2
