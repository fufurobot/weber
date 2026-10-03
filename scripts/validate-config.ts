/**
 * Validate the deliverable configuration files that are easy to get subtly
 * wrong: the CI workflow and the compose topology.
 *
 * Runs in CI and locally, and needs no YAML dependency.
 */
import { readFileSync } from "node:fs";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

/** Extremely small YAML subset reader: enough to sanity-check our own files. */
function sectionKeys(src: string, section: string): string[] {
  const lines = src.split(/\r?\n/);
  const keys: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inside = line.trim() === `${section}:`;
      continue;
    }
    if (inside) {
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):/);
      if (m) keys.push(m[1]!);
    }
  }
  return keys;
}

console.log("CI workflow");
{
  const src = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobs = sectionKeys(src, "jobs");
  check("declares test, e2e and compose jobs", ["test", "e2e", "compose"].every((j) => jobs.includes(j)), jobs.join(","));
  check("runs on pushes to main", /branches:\s*\[main\]/.test(src));
  check("runs the hermetic suite", /run:\s*bun test\b/.test(src));
  check("runs the spawn-dependent suite", /bun run test:e2e/.test(src));
  check("no stray tab indentation", !/\t/.test(src));
  check("no malformed bare 'steps' key", !/^\s*steps\s*$/.test(src));
  // `nginx -t` resolves upstream names at config time, so the check needs the
  // compose service name to exist as a host.
  check(
    "nginx syntax check maps the core hostname",
    /--add-host\s+core:/.test(src),
    "nginx -t fails with 'host not found in upstream' without it",
  );
}

console.log("nginx upstream consistency");
{
  const conf = readFileSync("compose/nginx.conf", "utf8");
  const compose = readFileSync("podman-compose.yml", "utf8");
  const upstream = conf.match(/server\s+([A-Za-z0-9_.-]+):(\d+)\s*;/);
  check("nginx declares an upstream server", upstream !== null);
  if (upstream) {
    const [, host, port] = upstream;
    // The proxied host must be a real compose service, and the port must match
    // what that service exposes, or the stack silently 502s.
    check(`upstream host '${host}' is a compose service`, sectionKeys(compose, "services").includes(host!));
    check(`core exposes the proxied port ${port}`, new RegExp(`expose:\\s*\\n\\s*-\\s*"${port}"`).test(compose));
  }
}

console.log("podman-compose.yml");
{
  const src = readFileSync("podman-compose.yml", "utf8");
  const services = sectionKeys(src, "services");
  check("declares web and core", ["web", "core"].every((s) => services.includes(s)), services.join(","));
  check("the edge publishes a host port", /^\s{4}ports:/m.test(src));
  check("a named volume backs the workspace", /weber-workspaces:/.test(src));
  check("both services define healthchecks", (src.match(/healthcheck:/g) ?? []).length >= 2);

  // The core must never be published: verify no `ports:` appears in its block.
  const coreBlock = src.split(/\n {2}core:\n/)[1]?.split(/\n {2}\w+:\n/)[0] ?? "";
  check("the core publishes no host port", !/^\s{4}ports:/m.test(coreBlock));
}

console.log("package.json");
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  check("exposes test", typeof pkg.scripts.test === "string");
  check("exposes test:e2e", typeof pkg.scripts["test:e2e"] === "string");
  check("exposes build:web", typeof pkg.scripts["build:web"] === "string");
}

if (failures > 0) {
  console.error(`\n${failures} configuration check(s) failed`);
  process.exit(1);
}
console.log("\nall configuration checks passed");
