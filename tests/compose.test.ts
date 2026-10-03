/**
 * Structural tests for the container topology.
 *
 * These run before any service exists: they pin the contract that the edge
 * (nginx) is the only published surface and that the core service carries the
 * runtime contract the rest of the system relies on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Minimal indentation-aware reader: enough to assert topology, not a YAML parser. */
function parseCompose(src: string) {
  const services = new Map<string, Record<string, string>>();
  let inServices = false;
  let current: string | null = null;
  let pendingKey: string | null = null;

  for (const rawLine of src.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine) || rawLine.trim() === "") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && indent === 0) break; // left the services block
    if (!inServices) continue;

    if (indent === 2 && line.endsWith(":")) {
      current = line.slice(0, -1);
      services.set(current, {});
      continue;
    }
    if (!current) continue;

    const svc = services.get(current)!;

    // Block-sequence item belonging to the previous key (e.g. "- 3000:8080").
    if (line.startsWith("- ")) {
      if (pendingKey) svc[pendingKey] = `${svc[pendingKey] ?? ""}${line.slice(2).trim()}\n`;
      continue;
    }
    if (indent >= 4 && line.includes(":")) {
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      // A bare "key:" means the value is a block sequence that follows.
      if (value === "") {
        pendingKey = key;
        svc[key] = "";
      } else {
        pendingKey = null;
        svc[key] = value;
      }
    }
  }
  return services;
}

describe("podman-compose topology", () => {
  const path = join(ROOT, "podman-compose.yml");

  test("compose file exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  test("declares the edge and core services", () => {
    const services = parseCompose(read("podman-compose.yml"));
    expect([...services.keys()]).toContain("web");
    expect([...services.keys()]).toContain("core");
  });

  test("only the edge publishes a host port", () => {
    const services = parseCompose(read("podman-compose.yml"));
    expect(services.get("web")!.ports).toBeTruthy();
    // The core service must stay on the internal network.
    expect(services.get("core")!.ports).toBeUndefined();
    expect(services.get("core")!.expose).toBeTruthy();
  });

  test("core is not reachable from the host, only via the edge network", () => {
    const src = read("podman-compose.yml");
    expect(src).toMatch(/networks:/);
  });

  test("services declare healthchecks so compose ordering is meaningful", () => {
    const src = read("podman-compose.yml");
    const healthchecks = src.match(/healthcheck:/g) ?? [];
    expect(healthchecks.length).toBeGreaterThanOrEqual(2);
  });

  test("workspace data is mounted as a volume, not baked into the image", () => {
    const src = read("podman-compose.yml");
    expect(src).toMatch(/volumes:/);
    expect(src).toMatch(/weber-workspaces|\.\/workspaces/);
  });
});

describe("edge routing contract", () => {
  test("nginx config routes api and websocket traffic to the core upstream", () => {
    const conf = read("compose/nginx.conf");
    expect(conf).toMatch(/upstream\s+weber_core/);
    expect(conf).toMatch(/location\s+\/api\//);
    expect(conf).toMatch(/location\s+\/ws/);
    expect(conf).toMatch(/proxy_set_header\s+Upgrade/);
  });

  test("nginx serves the SPA with a history fallback", () => {
    const conf = read("compose/nginx.conf");
    expect(conf).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  });

  test("the edge exposes its own health endpoint", () => {
    const conf = read("compose/nginx.conf");
    expect(conf).toMatch(/location\s+=\s+\/healthz/);
  });

  test("websocket proxying disables buffering and uses long timeouts", () => {
    const conf = read("compose/nginx.conf");
    expect(conf).toMatch(/proxy_buffering\s+off/);
    expect(conf).toMatch(/proxy_read_timeout\s+3600s/);
  });

  test("the upgrade map avoids sending 'upgrade' on plain http requests", () => {
    const conf = read("compose/nginx.conf");
    expect(conf).toMatch(/map\s+\$http_upgrade\s+\$connection_upgrade/);
    expect(conf).toMatch(/''\s+close/);
  });
});

describe("core service contract", () => {
  test("the core declares the port nginx proxies to", () => {
    const env = read("compose/.env.example");
    expect(env).toMatch(/CORE_PORT=8787/);
  });

  test("runtime configuration is overridable without rebuilding", () => {
    const env = read("compose/.env.example");
    expect(env).toMatch(/WEB_PORT=/);
    expect(env).toMatch(/WORKSPACE_ROOT=/);
  });
});
