/**
 * Core image contract.
 *
 * The Dockerfile is configuration, but its mistakes are expensive (a container
 * that boots without a healthcheck, or as root). These assertions pin the
 * properties that matter and run in the hermetic suite.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("compose/Dockerfile.core", () => {
  const path = join(ROOT, "compose/Dockerfile.core");

  test("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  test("builds on a Bun base image", () => {
    expect(read("compose/Dockerfile.core")).toMatch(/^FROM\s+oven\/bun:/m);
  });

  test("uses a multi-stage build so dev dependencies do not ship", () => {
    const src = read("compose/Dockerfile.core");
    const stages = src.match(/^FROM\s+/gm) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  test("runs as a non-root user", () => {
    const src = read("compose/Dockerfile.core");
    expect(src).toMatch(/^USER\s+(?!root)\w+/m);
  });

  test("declares the port that nginx proxies to", () => {
    expect(read("compose/Dockerfile.core")).toMatch(/EXPOSE\s+8787/);
  });

  test("defines a healthcheck hitting the health endpoint", () => {
    const src = read("compose/Dockerfile.core");
    expect(src).toMatch(/HEALTHCHECK/);
    expect(src).toMatch(/\/api\/health/);
  });

  test("creates the workspace directory with the right ownership", () => {
    const src = read("compose/Dockerfile.core");
    expect(src).toMatch(/\/workspaces/);
    expect(src).toMatch(/chown|--chown/);
  });

  test("installs production dependencies only in the runtime stage", () => {
    expect(read("compose/Dockerfile.core")).toMatch(/bun install/);
  });
});

describe("standalone deployment", () => {
  test("the server can serve the built SPA when no edge is present", () => {
    // Under compose nginx serves the SPA; a standalone deploy has no edge, so
    // the core must serve the same files or `GET /` 404s.
    const src = read("src/server/main.ts");
    expect(src).toMatch(/serveStatic/);
    expect(src).toMatch(/index\.html/);
  });

  test("static serving refuses to escape the build directory", () => {
    expect(read("src/server/main.ts")).toMatch(/rel\.includes\("\.\."\)/);
  });

  test("API paths are matched before the SPA fallback", () => {
    // Otherwise an unknown /api route returns index.html with a 200, which is
    // far harder to debug than a 404.
    const src = read("src/server/main.ts");
    const apiIdx = src.indexOf('startsWith("/api/")');
    const staticIdx = src.indexOf("await serveStatic");
    expect(apiIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeLessThan(staticIdx);
  });

  test("the web root is overridable by environment", () => {
    expect(read("src/server/main.ts")).toMatch(/WEBER_WEB_ROOT/);
  });
});

describe("deployment scripts", () => {
  test("the host installer sets a PATH for toolchain probing", () => {
    // systemd's default PATH is minimal, which makes every toolchain probe
    // report "not installed" even when the binary exists.
    const src = read("deploy/install-service.sh");
    expect(src).toMatch(/Environment=PATH=/);
    expect(src).toMatch(/\.bun\/bin/);
  });

  test("the installer restricts the environment file permissions", () => {
    expect(read("deploy/install-service.sh")).toMatch(/chmod 600/);
  });

  test("the installer generates a session secret rather than hardcoding one", () => {
    const src = read("deploy/install-service.sh");
    expect(src).toMatch(/dev\/urandom/);
    expect(src).not.toMatch(/WEBER_SESSION_SECRET=[A-Za-z0-9]{20,}/);
  });

  test("the installer binds to loopback by default", () => {
    expect(read("deploy/install-service.sh")).toMatch(/CORE_HOST=127\.0\.0\.1/);
  });

  test("no deploy script contains a real credential", () => {
    for (const script of [
      "deploy/install-service.sh",
      "deploy/build-on-host.sh",
      "deploy/setup-podman.sh",
    ]) {
      expect(read(script)).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    }
  });
});

describe("server entrypoint contract", () => {
  test("the entrypoint file exists", () => {
    expect(existsSync(join(ROOT, "src/server/main.ts"))).toBe(true);
  });

  test("the entrypoint reads host and port from the environment", () => {
    const src = read("src/server/main.ts");
    expect(src).toMatch(/CORE_PORT/);
    expect(src).toMatch(/CORE_HOST/);
  });

  test("the entrypoint reads the workspace root from the environment", () => {
    expect(read("src/server/main.ts")).toMatch(/WORKSPACE_ROOT/);
  });
});
