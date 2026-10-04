/**
 * Validate the deliverable configuration files that are easy to get subtly
 * wrong: the CI workflow and the compose topology.
 *
 * Runs in CI and locally, and needs no YAML dependency.
 */
import { readFileSync, existsSync } from "node:fs";

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

console.log("Dockerfile references");
{
  const compose = readFileSync("podman-compose.yml", "utf8");
  // A `dockerfile:` path is resolved relative to the service's build context.
  // All services here build from the repo root (`context: ..`), so paths are
  // repo-root relative and must exist as written.
  const referenced = [...compose.matchAll(/dockerfile:\s*(\S+)/g)].map((m) => m[1]!);
  check("compose references at least one Dockerfile", referenced.length > 0);
  check(
    "every service builds from the repo root context",
    (compose.match(/context:\s*\.\./g) ?? []).length === referenced.length,
    "a different context changes how dockerfile paths resolve",
  );
  for (const ref of referenced) {
    check(`Dockerfile referenced as '${ref}' exists`, existsSync(ref), ref);
  }
  for (const df of ["compose/Dockerfile.core", "compose/Dockerfile.web"]) {
    check(`${df} exists`, existsSync(df));
  }
}

console.log("Dockerfile build inputs");
{
  // A Dockerfile that runs a project script must COPY the directories that
  // script reads, or the build fails only inside the container.
  const web = readFileSync("compose/Dockerfile.web", "utf8");
  const core = readFileSync("compose/Dockerfile.core", "utf8");

  check("Dockerfile.web copies web/", /COPY\s+web\s/.test(web));
  check("Dockerfile.web copies scripts/ (runs build:web from it)", /COPY\s+scripts\s/.test(web));
  check("Dockerfile.core copies src/", /COPY[^\n]*src\s/.test(core));
  check(
    "Dockerfile.core copies bunfig.toml (bun test config)",
    /bunfig\.toml/.test(core),
  );

  // Every path a Dockerfile COPYs must exist in the repository.
  for (const [name, src] of [
    ["Dockerfile.web", web],
    ["Dockerfile.core", core],
  ] as const) {
    const copies = [...src.matchAll(/^COPY\s+(?!--from)([^\s]+)/gm)].map((m) => m[1]!);
    for (const target of copies) {
      if (target.includes("*")) continue; // optional lockfiles
      check(`${name} copies existing path '${target}'`, existsSync(target), target);
    }
  }
}

console.log("GitHub Pages workflow");
{
  const pages = readFileSync(".github/workflows/pages.yml", "utf8");
  check(
    "has the permissions Pages deployment requires",
    /pages:\s*write/.test(pages) && /id-token:\s*write/.test(pages),
  );
  check("runs the build:pages script", /bun run build:pages/.test(pages));
  check("uploads the dist/pages artifact", /path:\s*dist\/pages/.test(pages));
  check("declares a github-pages environment", /name:\s*github-pages/.test(pages));
  check("the pages build script exists", existsSync("scripts/build-pages.ts"));
  check("a mock backend exists for the static demo", existsSync("web/mock-api.ts"));
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
