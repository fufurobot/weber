#!/bin/bash
# Try to get rootless podman working WITHOUT newuidmap.
#
# podman uses multiple-ID mapping because /etc/subuid lists subuids for this
# user, and that path requires the setuid newuidmap helper. Two options:
#
#   A. Force single-ID mapping, which needs no helper at all.
#   B. Build newuidmap/newgidmap from source (they are tiny C programs) and put
#      them on PATH — but they must be setuid root to work, which we cannot do.
#
# So: try A.
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1
CONF="$HOME/.config/containers"

echo "=== attempting single-ID mapping via storage/containers config ==="
# With no subuid mapping declared, podman maps only the current user, which
# needs no setuid helper.
cat > "$CONF/containers.conf" <<'EOF'
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
runtime = "crun"
default_network = "slirp4netns:allow_host_loopback=true"

[containers]
annotations = ["run.oci.keep_original_groups=1"]
EOF

echo "--- attempt 1: plain run ---"
podman info --format '{{.Host.Security.Rootless}}|{{.Store.GraphDriverName}}' 2>&1 | tail -3

echo
echo "--- attempt 2: with a private subuid file via env ---"
# Some podman versions read a user-level override.
mkdir -p "$HOME/.config/containers"
printf 'fufu:1:1\n' > "$HOME/.config/containers/subuid" 2>/dev/null || true
printf 'fufu:1:1\n' > "$HOME/.config/containers/subgid" 2>/dev/null || true
podman info --format '{{.Host.Security.Rootless}}' 2>&1 | tail -2

echo
echo "--- attempt 3: does podman work at all for a trivial command? ---"
podman images 2>&1 | head -3

echo
echo "--- what does podman think its mappings are? ---"
podman unshare cat /proc/self/uid_map 2>&1 | head -5
