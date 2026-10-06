#!/bin/bash
# Verify rootless podman now that newuidmap/newgidmap are on PATH.
export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1

echo "=== which helpers ==="
command -v podman newuidmap newgidmap crun conmon

echo
echo "=== podman info ==="
podman info --format 'rootless={{.Host.Security.Rootless}} driver={{.Store.GraphDriverName}} cgroup={{.Host.CgroupVersion}}' 2>&1 | tail -4

echo
echo "=== userns mapping as podman sees it ==="
podman unshare cat /proc/self/uid_map 2>&1 | head -4

echo
echo "=== can we pull an image? (small one) ==="
timeout 180 podman pull docker.io/library/hello-world 2>&1 | tail -5

echo
echo "=== run it ==="
timeout 120 podman run --rm docker.io/library/hello-world 2>&1 | tail -6
