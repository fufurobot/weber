/**
 * Single-image deployment for PaaS.
 *
 * Workstream 2: one image that runs everything, because Heroku and similar
 * platforms give one container, not a compose network. That removes the nginx
 * edge, so the core must serve the SPA itself — which it already can, but the
 * combination has never been the *default* before and nothing has asserted it.
 *
 * These tests read the configuration rather than build the image, because no
 * container runtime is available here. That is a real limitation and it is
 * recorded in docs/IMPLEMENTATION.md rather than glossed over.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

const PAAS = "deploy/paas";

describe("single-image Dockerfile", () => {
  const path = `${PAAS}/Dockerfile`;

  test("exists", () => {
    expect(exists(path)).toBe(true);
  });

  test("builds on Bun, since that is the runtime the core needs", () => {
    expect(read(path)).toMatch(/^FROM\s+oven\/bun:/m);
  });

  test("is multi-stage, so build tooling does not ship", () => {
    const stages = read(path).match(/^FROM\s+/gm) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  test("serves the SPA from the core, because there is no nginx edge", () => {
    // On a PaaS there is one process and one port. Without this the deployment
    // answers the API and 404s the UI.
    expect(read(path)).toMatch(/build:web|dist\/web/);
  });

  test("respects the platform's PORT variable", () => {
    // Heroku assigns PORT at runtime; binding a hardcoded port means the
    // router never reaches the app.
    const src = read(path);
    expect(src).toMatch(/\$\{?PORT/);
  });

  test("binds 0.0.0.0, not loopback", () => {
    // A PaaS router connects from outside the container.
    expect(read(path)).toMatch(/CORE_HOST=0\.0\.0\.0/);
  });

  test("runs as a non-root user", () => {
    expect(read(path)).toMatch(/^USER\s+(?!root)\w+/m);
  });

  test("declares a healthcheck", () => {
    expect(read(path)).toMatch(/HEALTHCHECK/);
    expect(read(path)).toMatch(/\/api\/health/);
  });

  test("warns that it is unauthenticated unless configured", () => {
    // Weber executes user code; the image must not make silent exposure easy.
    const src = read(path);
    expect(src).toMatch(/AUTH|auth/i);
  });
});

describe("Procfile", () => {
  test("exists at the repository root", () => {
    expect(exists("Procfile")).toBe(true);
  });

  test("declares a web process", () => {
    expect(read("Procfile")).toMatch(/^web:/m);
  });

  test("runs the core, which now also serves the SPA", () => {
    const src = read("Procfile");
    expect(src).toMatch(/src\/server\/main\.ts|bun/);
  });

  test("does not reference nginx, which a single dyno cannot run", () => {
    expect(read("Procfile")).not.toMatch(/nginx/);
  });
});

describe("platform metadata", () => {
  test("app.json describes the required OAuth configuration", () => {
    expect(exists("app.json")).toBe(true);
    const app = JSON.parse(read("app.json")) as {
      env?: Record<string, { description?: string; required?: boolean }>;
    };
    expect(app.env).toBeDefined();
    // Deploying without these yields an open shell, so they must be
    // surfaced at deploy time rather than discovered afterwards.
    expect(Object.keys(app.env ?? {})).toContain("GITHUB_CLIENT_ID");
    expect(Object.keys(app.env ?? {})).toContain("WEBER_ALLOWED_LOGINS");
  });

  test("app.json explains what each variable is for", () => {
    const app = JSON.parse(read("app.json")) as {
      env?: Record<string, { description?: string }>;
    };
    for (const [name, spec] of Object.entries(app.env ?? {})) {
      expect(`${name}:${spec.description ?? ""}`).toMatch(/:.+/);
    }
  });

  test("a .dockerignore keeps the image context small", () => {
    expect(exists(`${PAAS}/.dockerignore`) || exists(".dockerignore")).toBe(true);
  });

  test("the ignore file excludes the large directories", () => {
    const file = exists(`${PAAS}/.dockerignore`) ? `${PAAS}/.dockerignore` : ".dockerignore";
    const src = read(file);
    for (const entry of ["node_modules", "dist"]) {
      expect(src).toContain(entry);
    }
  });
});

describe("combined-mode behaviour", () => {
  test("the server serves static files when configured to", () => {
    // Already implemented for the standalone deployment; asserted here
    // because PaaS is exactly that case.
    expect(read("src/server/main.ts")).toMatch(/createStaticHandler/);
    expect(read("src/server/main.ts")).toMatch(/WEBER_WEB_ROOT/);
  });

  test("auth is enforced only when both values are present", () => {
    // Half-configured auth must not silently pass traffic.
    const src = read("src/server/main.ts");
    expect(src).toMatch(/authEnabled/);
    expect(src).toMatch(/githubClientId\.length > 0 && allowedLogins\.length > 0/);
  });

  test("the server refuses to start with a short session secret", () => {
    expect(read("src/server/main.ts")).toMatch(/WEBER_SESSION_SECRET must be at least/);
  });

  test("warns loudly when exposed without authentication", () => {
    const src = read("src/server/main.ts");
    expect(src).toMatch(/WARNING: listening on/);
    expect(src).toMatch(/command runner/);
  });
});
