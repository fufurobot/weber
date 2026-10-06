#!/bin/bash
# Weber — rootless podman setup for a host with a static podman release.
#
# Assumes no sudo: everything lives under $HOME. The static release ships
# podman, crun, conmon, netavark, aardvark-dns, pasta and fuse-overlayfs, so the
# only work is generating config that points podman at them.
set -euo pipefail

PODMAN_ROOT="$HOME/podman-linux-amd64"
PREFIX="$PODMAN_ROOT/usr/local"
BIN="$PREFIX/bin"
CONF="$HOME/.config/containers"

echo "=== 1. verifying the release ==="
for f in "$BIN/podman" "$BIN/crun" "$BIN/fuse-overlayfs" "$PREFIX/lib/podman/conmon"; do
  if [ ! -x "$f" ]; then
    echo "FATAL: missing or not executable: $f" >&2
    exit 1
  fi
done
echo "ok: podman, crun, fuse-overlayfs and conmon are present"

echo "=== 2. config directory ==="
mkdir -p "$CONF"

# Containers.conf: point podman at the bundled helpers and use cgroupfs, which
# is what works on this hybrid-cgroup host without a systemd user session
# managing a delegated subtree.
cat > "$CONF/containers.conf" <<EOF
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
runtime = "crun"
conmon_path = ["$PREFIX/lib/podman/conmon"]
helper_binaries_dir = ["$PREFIX/lib/podman", "$PREFIX/bin"]
# Rootless networking without root: pasta/slirp4netns both work here.
default_network = "slirp4netns:allow_host_loopback=true"

[containers]
# The kernel here restricts some namespaces; keep the defaults that work.
annotations = ["run.oci.keep_original_groups=1"]
EOF

# Storage: fuse-overlayfs in the user namespace (no root needed) with a vfs
# fallback, because overlay-in-userns is not guaranteed on this kernel.
cat > "$CONF/storage.conf" <<EOF
[storage]
driver = "overlay"
graphroot = "$HOME/.local/share/containers/storage"
runroot = "/run/user/$(id -u)/containers"

[storage.options.overlay]
mount_program = "$BIN/fuse-overlayfs"

[storage.options]
additionalimagestores = []
EOF

echo "=== 3. PATH shim in ~/.local/bin ==="
mkdir -p "$HOME/.local/bin"
for tool in podman crun fuse-overlayfs pasta; do
  ln -sfn "$BIN/$tool" "$HOME/.local/bin/$tool"
done
ln -sfn "$PREFIX/lib/podman/conmon" "$HOME/.local/bin/conmon"
echo "linked: $(ls "$HOME/.local/bin" | tr '\n' ' ')"

echo "=== 4. smoke test: podman info ==="
export PATH="$HOME/.local/bin:$PATH"
podman --version
podman info --format '{{.Host.Security.Rootless}} {{.Store.GraphDriverName}}' 2>&1 | tail -3

echo "=== done ==="
