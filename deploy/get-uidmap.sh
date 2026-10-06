#!/bin/bash
# newuidmap/newgidmap ship in the shadow-utils (uidmap) package. We cannot apt
# install (no sudo), but the .deb can be downloaded and unpacked into $HOME
# WITHOUT installing it. The catch: newuidmap must be setuid root to work, and
# we cannot set the setuid bit as a normal user.
#
# So this script determines whether that catch is fatal, and otherwise whether
# the host's docker can be used rootlessly instead.
set -uo pipefail

echo "=== can we download the uidmap .deb? ==="
cd /tmp || exit 1
URL="http://archive.ubuntu.com/ubuntu/pool/main/s/shadow/uidmap_4.8.1-1ubuntu5.20.04.5_amd64.deb"
curl -s -m 60 -o uidmap.deb -w "download http=%{http_code} size=%{size_download}\n" "$URL" || echo "download failed"

if [ -s uidmap.deb ]; then
  echo "=== extract without root ==="
  rm -rf uidmap-x && mkdir uidmap-x
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x uidmap.deb uidmap-x 2>&1 | head -3
  else
    # No dpkg-deb: use ar + tar, both usually present.
    ar x uidmap.deb 2>/dev/null && tar -xf data.tar.* -C uidmap-x 2>/dev/null
  fi
  echo "--- extracted binaries ---"
  find uidmap-x -name 'newuidmap' -o -name 'newgidmap' 2>/dev/null

  BIN=$(find uidmap-x -name 'newuidmap' 2>/dev/null | head -1)
  if [ -n "$BIN" ]; then
    mkdir -p "$HOME/.local/bin"
    cp "$BIN" "$HOME/.local/bin/newuidmap"
    G=$(find uidmap-x -name 'newgidmap' | head -1)
    [ -n "$G" ] && cp "$G" "$HOME/.local/bin/newgidmap"
    chmod 755 "$HOME/.local/bin/newuidmap" "$HOME/.local/bin/newgidmap" 2>/dev/null
    echo "--- installed to ~/.local/bin (NOT setuid) ---"
    ls -l "$HOME/.local/bin/newuidmap" "$HOME/.local/bin/newgidmap"
    echo "--- does it work without setuid? ---"
    export PATH="$HOME/.local/bin:$PATH"
    newuidmap 2>&1 | head -2
  fi
else
  echo "could not download the package"
fi

echo
echo "=== alternative: is the host docker usable rootlessly? ==="
echo "docker binary: $(command -v docker || echo missing)"
echo "dockerd-rootless-setuptool: $(command -v dockerd-rootless-setuptool.sh || echo missing)"
ls -l /usr/bin/dockerd 2>/dev/null || echo "no dockerd binary visible"
