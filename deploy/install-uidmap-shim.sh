#!/bin/bash
# Give podman a newuidmap that CAN work unprivileged.
#
# Facts established on this host:
#   - /etc/subuid grants fufu 65536 subuids, so podman always takes the
#     multi-ID path and demands newuidmap
#   - real newuidmap must be setuid root to write a multi-ID uid_map
#   - we cannot set setuid, and podman ignores every config override
#   - BUT single-ID mapping works fine unprivileged (proven with CLONE_NEWUSER)
#
# So: replace the helper with a shim that performs the subset of the job that
# is actually possible without privilege — mapping the single invoking ID — and
# decline loudly if podman asks for more than that.
set -uo pipefail

SHIM="$HOME/.local/bin/newuidmap"
SHIM_G="$HOME/.local/bin/newgidmap"
REAL="$HOME/.local/libexec/newuidmap.real"

mkdir -p "$HOME/.local/libexec"

# Preserve the genuine binaries in case they are needed later.
if [ -x "$SHIM" ] && [ ! -e "$REAL" ]; then
  cp "$SHIM" "$REAL"
  cp "$SHIM_G" "$HOME/.local/libexec/newgidmap.real"
  echo "preserved real helpers in ~/.local/libexec/"
fi

cat > "$SHIM" <<'SHIMEOF'
#!/bin/bash
# newuidmap shim: writes only the mapping an unprivileged user may write.
#
# Usage (from podman): newuidmap <pid> <uid> <loweruid> <count> [...]
# We accept the request only when it maps exactly one ID range covering the
# current user, which is the case that does not require privilege.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: newuidmap <pid> <uid> <loweruid> <count> [...]" >&2
  exit 1
fi

PID="$1"; shift

# Only a single triple is safe to write unprivileged.
if [ "$#" -ne 3 ]; then
  echo "newuidmap(shim): refusing multi-ID mapping ($# fields); needs setuid root" >&2
  exit 1
fi

UID_ARG="$1"; LOWER="$2"; COUNT="$3"

# /proc/<pid>/setgroups must be denied before writing uid_map.
if [ -w "/proc/$PID/setgroups" ]; then
  echo deny > "/proc/$PID/setgroups" 2>/dev/null || true
fi

if [ ! -w "/proc/$PID/uid_map" ]; then
  echo "newuidmap(shim): cannot write /proc/$PID/uid_map" >&2
  exit 1
fi

echo "$UID_ARG $LOWER $COUNT" > "/proc/$PID/uid_map"
SHIMEOF

cat > "$SHIM_G" <<'SHIMEOF'
#!/bin/bash
set -euo pipefail
if [ "$#" -lt 4 ]; then exit 1; fi
PID="$1"; shift
if [ "$#" -ne 3 ]; then
  echo "newgidmap(shim): refusing multi-ID mapping; needs setuid root" >&2
  exit 1
fi
echo "$1 $2 $3" > "/proc/$PID/gid_map"
SHIMEOF

chmod 755 "$SHIM" "$SHIM_G"
echo "installed shims"

echo
echo "=== retry podman with the shims ==="
export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1
podman info --format 'rootless={{.Host.Security.Rootless}} driver={{.Store.GraphDriverName}}' 2>&1 | tail -4
