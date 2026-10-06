#!/bin/bash
# Exercise the deployed instance end to end, from the host itself.
set -uo pipefail
B="http://127.0.0.1:8080"

echo "=== seeded workspace ==="
curl -s -m 10 "$B/api/fs/list?path=" | tr ',' '\n' | grep -E '"path"' | head -6

echo
echo "=== write a file through the API ==="
curl -s -m 10 -X PUT "$B/api/fs/file?path=deploy-check.txt" \
  -H 'content-type: application/json' \
  -d '{"contents":"written on the deployed host"}'
echo
curl -s -m 10 "$B/api/fs/file?path=deploy-check.txt"
echo

echo
echo "=== run a real command (bun is available on the host) ==="
curl -s -m 30 -X POST "$B/api/tools/run" \
  -H 'content-type: application/json' \
  -d '{"argv":["bun","--version"]}'
echo

echo
echo "=== run a command in a subdirectory ==="
curl -s -m 30 -X POST "$B/api/tools/run" \
  -H 'content-type: application/json' \
  -d '{"argv":["bun","-e","console.log(process.cwd())"],"cwd":"src"}'
echo

echo
echo "=== notebook reactivity (template interpolation, the fixed bug) ==="
curl -s -m 20 -X POST "$B/api/notebook/run" \
  -H 'content-type: application/json' \
  -d '{"cells":[{"id":"a","code":"const base = 7;"},{"id":"b","code":"const answer = base * 6;"},{"id":"c","code":"const label = `answer=${answer}`;"}]}'
echo

echo
echo "=== security: traversal blocked ==="
curl -s -m 10 "$B/api/fs/file?path=../../etc/passwd"
echo

echo
echo "=== security: unlisted binary blocked ==="
curl -s -m 10 -X POST "$B/api/tools/run" \
  -H 'content-type: application/json' \
  -d '{"argv":["curl","http://example.com"]}' | head -c 200
echo

echo
echo "=== auth status (unauthenticated deploy on loopback) ==="
curl -s -m 10 "$B/api/auth/status"
echo
