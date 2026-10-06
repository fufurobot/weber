#!/bin/bash
# Survey the deployment target for rootless container options.
echo "=== apt candidates (query only, no sudo) ==="
apt-cache policy podman fuse-overlayfs uidmap slirp4netns 2>/dev/null | grep -E "^[a-z]|Candidate" | head -20

echo "=== writable locations ==="
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  if [ -w "$d" ] 2>/dev/null; then echo "writable:   $d"; else echo "not-writable: $d"; fi
done

echo "=== free space ==="
df -h "$HOME" | tail -1

echo "=== existing rootless docker state ==="
ls -la "$HOME/.local/share/docker" 2>/dev/null | head -3 || echo "none"

echo "=== docker version on host ==="
docker --version 2>/dev/null
docker compose version 2>/dev/null || echo "no docker compose plugin"

echo "=== docker socket perms ==="
ls -l /var/run/docker.sock 2>/dev/null

echo "=== can we reach a registry for a static podman download ==="
curl -s -m 15 -o /dev/null -w "github releases %{http_code}\n" https://github.com/containers/podman/releases

echo "=== cgroup delegation for user session ==="
cat /sys/fs/cgroup/unified/cgroup.controllers 2>/dev/null || echo "(no unified controllers)"
systemctl --user show-environment 2>/dev/null | head -3
