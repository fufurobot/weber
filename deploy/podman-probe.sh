#!/bin/bash
# Probe the static podman install and prepare a rootless configuration.
set -u

PREFIX="$HOME/podman-linux-amd64/usr/local"
export PATH="$PREFIX/bin:$HOME/.local/bin:$PATH"

echo "=== podman version ==="
podman --version 2>&1 | head -2

echo "=== crun ==="
crun --version 2>&1 | head -2

echo "=== fuse-overlayfs ==="
fuse-overlayfs --version 2>&1 | head -2

echo "=== default runtime / storage config location ==="
podman info --debug 2>&1 | grep -iE "rootless|graphDriver|runtime|overlay|error" | head -20

echo "=== existing containers.conf in the release ==="
cat "$HOME/podman-linux-amd64/etc/containers/containers.conf" 2>/dev/null | head -40
