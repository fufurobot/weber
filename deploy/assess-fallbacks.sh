#!/bin/bash
# Rootless podman is blocked by a kernel-enforced privilege boundary:
# newuidmap must be setuid root to install a multi-ID mapping, and podman takes
# the multi-ID path because /etc/subuid grants this user subuids.
#
# Options that remain, all without sudo:
#   A. rootless DOCKER via the host's /usr/bin/dockerd + setuptool script
#   B. bare Bun: run the core and the built SPA under a user service
#
# This script evaluates A; B is the guaranteed fallback.
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1

echo "=== A. rootless docker prerequisites ==="
echo "dockerd:        $(command -v dockerd || echo missing)"
echo "dockerd-rootless-setuptool.sh: $(command -v dockerd-rootless-setuptool.sh || echo missing)"
echo "rootlesskit:    $(command -v rootlesskit || echo missing)"
echo "slirp4netns:    $(command -v slirp4netns || echo missing)"
echo "newuidmap:      $(command -v newuidmap || echo missing)"

echo
echo "=== would rootless docker hit the same setuid wall? ==="
echo "It uses rootlesskit, which needs newuidmap for multi-ID mapping too."
echo "newuidmap capabilities:"
getcap "$HOME/.local/bin/newuidmap" 2>/dev/null || echo "  (none)"
echo "system newuidmap:"
ls -l /usr/bin/newuidmap 2>/dev/null || echo "  (absent)"

echo
echo "=== B. bare Bun: is Bun already on the host? ==="
ls -la "$HOME/.bun/bin" 2>/dev/null | head -5 || echo "no ~/.bun/bin"
command -v bun || echo "bun not on PATH"
# The home directory listing showed .bun and bun.sh earlier.
find "$HOME/.bun" -maxdepth 3 -name 'bun' -type f 2>/dev/null | head -3

echo
echo "=== B2. node/npm available as an alternative runtime? ==="
ls -d "$HOME/.nvm/versions/node"/* 2>/dev/null | head -3
command -v node npm 2>/dev/null || echo "node/npm not on PATH (nvm may need sourcing)"

echo
echo "=== disk headroom for a Bun deploy ==="
df -h "$HOME" | tail -1
