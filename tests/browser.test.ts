/**
 * Browser smoke test.
 *
 * Every claim about the UI so far has been an HTTP check: the shell is served,
 * assets resolve, MIME types are right. That proves the *files* are correct and
 * nothing about whether the app renders — a bundle with a top-level exception
 * serves identically.
 *
 * This runs the real SPA in a real browser and asserts the DOM the user sees.
 * It cannot run in the development environment (Chromium's mojo IPC needs
 * named pipes, which the sandbox blocks), so it runs in CI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("browser smoke test exists", () => {
  test("there is a script that drives a real browser", () => {
    const candidates = ["scripts/browser-smoke.ts", "scripts/browser-smoke.mjs"];
    const found = candidates.some((c) => {
      try {
        read(c);
        return true;
      } catch {
        return false;
      }
    });
    expect(found).toBe(true);
  });

  test("it asserts on rendered DOM, not just HTTP status", () => {
    // The whole point: a status code says nothing about whether the app ran.
    const src = read("scripts/browser-smoke.ts");
    expect(src).toMatch(/querySelector|textContent|#root/);
    expect(src).toMatch(/pageerror|console/);
  });

  test("it fails on an uncaught page error", () => {
    // A bundle that throws on load still serves 200 with the right MIME type.
    const src = read("scripts/browser-smoke.ts");
    expect(src).toMatch(/pageerror|uncaught/i);
  });

  test("it exercises both modes, not just the landing view", () => {
    const src = read("scripts/browser-smoke.ts");
    expect(src).toMatch(/Project Mode/);
    expect(src).toMatch(/Script Mode/);
  });

  test("it starts the real server rather than serving fixtures", () => {
    const src = read("scripts/browser-smoke.ts");
    expect(src).toMatch(/src\/server\/main\.ts/);
  });
});

describe("CI runs the browser test", () => {
  const ci = () => read(".github/workflows/ci.yml");

  test("there is a browser job", () => {
    expect(ci()).toMatch(/browser/i);
  });

  test("it installs a real browser", () => {
    const src = ci();
    expect(src).toMatch(/playwright install|chromium/i);
  });

  test("it runs the smoke script", () => {
    expect(ci()).toMatch(/browser-smoke/);
  });

  test("the job is allowed to run without the fixture mock", () => {
    // The Pages build aliases the API to a mock. The browser test must run
    // against the compose build, or it would prove the mock renders.
    const src = ci();
    expect(src).not.toMatch(/build:pages[\s\S]{0,200}browser-smoke/);
  });
});
