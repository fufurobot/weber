#!/bin/bash
# Two viable paths, in order of preference:
#
#   1. rootless DOCKER, using the host's own /usr/bin/dockerd, which is world
#      executable. dockerd-rootless-setuptool.sh is present. This still needs
#      newuidmap for multi-id mapping though, so check first.
#   2. Fetch uidmap from a working mirror and see if a non-setuid newuidmap is
#      enough (it is not, normally — but verify rather than assume).
set -uo pipefail

echo "=== A. locate a working uidmap package ==="
for u in \
  "http://archive.ubuntu.com/ubuntu/pool/main/s/shadow/uidmap_4.8.1-1ubuntu5.20.04.5_amd64.deb" \
  "http://security.ubuntu.com/ubuntu/pool/main/s/shadow/uidmap_4.8.1-1ubuntu5.20.04.5_amd64.deb" \
  "http://mirrors.tencent.com/ubuntu/pool/main/s/shadow/uidmap_4.8.1-1ubuntu5.20.04.5_amd64.deb" \
  "http://mirrors.aliyun.com/ubuntu/pool/main/s/shadow/uidmap_4.8.1-1ubuntu5.20.04.5_amd64.deb" ; do
  code=$(curl -s -m 25 -o /tmp/u.deb -w '%{http_code}' "$u")
  size=$(stat -c %s /tmp/u.deb 2>/dev/null || echo 0)
  echo "  $code  $size  $u"
  if [ "$code" = "200" ] && [ "$size" -gt 10000 ]; then
    echo "  -> using $u"
    cp /tmp/u.deb /tmp/uidmap-ok.deb
    break
  fi
done

echo
echo "=== B. does the ubuntu archive even resolve/answer? ==="
curl -s -m 20 -o /dev/null -w "archive.ubuntu.com %{http_code}\n" http://archive.ubuntu.com/ubuntu/
curl -s -m 20 -o /dev/null -w "security.ubuntu.com %{http_code}\n" http://security.ubuntu.com/ubuntu/
curl -s -m 20 -o /dev/null -w "mirrors.tencent.com %{http_code}\n" http://mirrors.tencent.com/ubuntu/

echo
echo "=== C. is there an apt archive already on disk with the package? ==="
ls /var/cache/apt/archives/*.deb 2>/dev/null | head -5 || echo "no cached debs"

echo
echo "=== D. what apt sources are configured (readable without root)? ==="
grep -rhs '^deb ' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | head -6

echo
echo "=== E. does the host's dockerd support rootless already? ==="
/usr/bin/dockerd --version 2>&1 | head -1
