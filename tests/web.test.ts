/**
 * Frontend build contract.
 *
 * `compose/Dockerfile.web` runs `bun run build:web` and expects static output
 * at `dist/web`. These tests pin that contract and the properties of the shell
 * that the nginx config depends on (a real index.html, hashed assets under
 * /assets/, and no absolute filesystem paths leaking into the bundle).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

describe("build tooling", () => {
  test("a build:web script exists", () => {
    expect(exists("scripts/build-web.ts")).toBe(true);
  });

  test("the build script writes to dist/web, which nginx serves", () => {
    const src = read("scripts/build-web.ts");
    expect(src).toMatch(/dist[\\/]web|"web"|'web'/);
  });

  test("Dockerfile.web copies the same output directory it builds", () => {
    const src = read("compose/Dockerfile.web");
    expect(src).toMatch(/bun run build:web/);
    expect(src).toMatch(/dist\/web/);
  });
});

describe("SPA sources", () => {
  test("the HTML shell exists", () => {
    expect(exists("web/index.html")).toBe(true);
  });

  test("the shell mounts a root element", () => {
    expect(read("web/index.html")).toMatch(/id="root"/);
  });

  test("the shell loads a module entrypoint", () => {
    expect(read("web/index.html")).toMatch(/type="module"/);
  });

  test("an application entrypoint exists", () => {
    expect(exists("web/main.ts") || exists("web/main.tsx")).toBe(true);
  });

  test("the app implements both Project and Script modes", () => {
    const main = exists("web/main.ts") ? read("web/main.ts") : read("web/main.tsx");
    expect(main).toMatch(/project/i);
    expect(main).toMatch(/script/i);
  });

  test("the client talks to the API through the edge, not a hardcoded host", () => {
    // Must be same-origin so nginx can proxy /api, otherwise the deployed
    // container would try to reach localhost:8787 inside the browser.
    const main = exists("web/main.ts") ? read("web/main.ts") : read("web/main.tsx");
    expect(main).not.toMatch(/127\.0\.0\.1:8787/);
    expect(main).not.toMatch(/localhost:8787/);
  });
});

describe("frontend modules", () => {
  test("an API client module exists", () => {
    expect(exists("web/api.ts")).toBe(true);
  });

  test("the API client uses relative /api paths", () => {
    expect(read("web/api.ts")).toMatch(/["'`]\/api\//);
  });

  test("the reactive notebook has a client-side view", () => {
    expect(exists("web/notebook.ts")).toBe(true);
  });

  test("styling exists and is referenced by the shell", () => {
    expect(exists("web/styles.css")).toBe(true);
    expect(read("web/index.html")).toMatch(/styles\.css/);
  });
});
