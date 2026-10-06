#!/bin/bash
# Last rootless option: single-ID mapping.
#
# podman only demands newuidmap because /etc/subuid grants this user multiple
# subuids. If podman believes there is exactly one ID to map, it can write
# uid_map directly (which an unprivileged user IS allowed to do for their own
# namespace) and never needs the setuid helper.
#
# podman 5.x reads subuid data from containers.conf when the global files are
# unreadable/overridden. Try forcing a single-ID mapping.
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export PODMAN_IGNORE_CGROUPSV1_WARNING=1
export _CONTAINERS_USERNS_CONFIGURED=""
CONF="$HOME/.config/containers"

echo "=== forcing single-ID mapping ==="
cat > "$CONF/containers.conf" <<'EOF'
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
runtime = "crun"
# Map only the invoking user. No subordinate IDs means no setuid helper.
remap_uids = ""
remap_gids = ""

[containers]
annotations = ["run.oci.keep_original_groups=1"]
EOF

echo "--- attempt with subuid override files ---"
# Some versions honour XDG_CONTAINERS_* overrides for these.
printf 'fufu:1:1\n' > "$CONF/subuid"
printf 'fufu:1:1\n' > "$CONF/subgid"
XDG_CONTAINERS_SUBUID="$CONF/subuid" XDG_CONTAINERS_SUBGID="$CONF/subgid" \
  podman info --format 'rootless={{.Host.Security.Rootless}}' 2>&1 | tail -3

echo
echo "--- attempt: hide subuid by pointing at an empty file ---"
: > "$CONF/empty-subuid"
CONTAINERS_SUBUID_FILE="$CONF/empty-subuid" CONTAINERS_SUBGID_FILE="$CONF/empty-subuid" \
  podman info --format 'rootless={{.Host.Security.Rootless}}' 2>&1 | tail -3

echo
echo "--- attempt: does an unprivileged user really get to write uid_map? ---"
# This proves whether single-ID mapping is viable at all on this kernel.
cat > /tmp/mapcheck.c <<'EOF'
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
    if (unshare(CLONE_NEWUSER) != 0) { perror("unshare"); return 1; }
    FILE *f = fopen("/proc/self/setgroups", "w");
    if (f) { fputs("deny", f); fclose(f); }
    f = fopen("/proc/self/uid_map", "w");
    if (!f) { perror("open uid_map"); return 1; }
    fprintf(f, "0 %d 1\n", getuid());
    fclose(f);
    printf("single-ID mapping works\n");
    return 0;
}
EOF
if command -v gcc >/dev/null 2>&1; then
  gcc -o /tmp/mapcheck /tmp/mapcheck.c 2>&1 | head -3 && /tmp/mapcheck
else
  echo "no gcc; testing with unshare instead"
  unshare --user --map-root-user id 2>&1 | head -2
fi

echo
echo "=== summary of what podman needs vs what we have ==="
echo "newuidmap: $(command -v newuidmap)"
getcap "$HOME/.local/bin/newuidmap" 2>/dev/null || echo "no capabilities on newuidmap"
ls -l "$HOME/.local/bin/newuidmap"
