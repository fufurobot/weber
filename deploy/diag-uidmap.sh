#!/bin/bash
# Investigate the missing newuidmap and whether podman can run without it.
export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1

echo "=== release bin contents ==="
ls -1 "$HOME/podman-linux-amd64/usr/local/bin/"

echo
echo "=== newuidmap/newgidmap anywhere on the system ==="
find /usr /bin /sbin -name 'newuidmap' -o -name 'newgidmap' 2>/dev/null | head -5
echo "(end)"

echo
echo "=== subuid/subgid ==="
grep '^fufu:' /etc/subuid /etc/subgid 2>/dev/null || echo "no entries"

echo
echo "=== which mapping does podman want ==="
podman info --format '{{.Host.IDMappings}}' 2>&1 | head -5

echo
echo "=== can we map a single id without newuidmap? ==="
# Without newuidmap, rootless podman can only map the current uid/gid.
# Deleting the subuid entries forces single-id mapping.
podman unshare id 2>&1 | head -3

echo
echo "=== userns_supported ==="
cat /proc/sys/user/max_user_namespaces

echo
echo "=== is /etc/subuid writable by us? ==="
test -w /etc/subuid && echo "writable" || echo "not writable"
