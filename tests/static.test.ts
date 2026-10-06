/**
 * Static serving.
 *
 * The standalone deployment has no nginx, so the core serves the built SPA.
 * This shipped broken once: the guard used `Bun.file(<directory>).exists()`,
 * which is false, so the function bailed out and `GET /` returned 404 while
 * every other test passed. These tests exercise the real filesystem.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler } from "../src/server/static";

let webRoot: string;

beforeEach(() => {
  webRoot = mkdtempSync(join(tmpdir(), "weber-static-"));
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(webRoot, "assets", "main-abc123.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "styles-def456.css"), "body{}");
});

afterEach(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("createStaticHandler", () => {
  test("serves index.html at the root", async () => {
    const serve = createStaticHandler(webRoot);
    const res = await serve("/");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("id=root");
  });

  test("serves a hashed asset", async () => {
    const serve = createStaticHandler(webRoot);
    const res = await serve("/assets/main-abc123.js");
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("console.log");
  });

  test("serves assets with immutable caching", async () => {
    const serve = createStaticHandler(webRoot);
    const res = await serve("/assets/main-abc123.js");
    expect(res!.headers.get("cache-control")).toContain("immutable");
  });

  test("never caches the shell", async () => {
    const serve = createStaticHandler(webRoot);
    const res = await serve("/");
    expect(res!.headers.get("cache-control")).toContain("no-store");
  });

  test("falls back to the shell for a client-side route", async () => {
    const serve = createStaticHandler(webRoot);
    const res = await serve("/some/spa/route");
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("id=root");
  });

  test("does NOT fall back for a missing asset", async () => {
    // Returning HTML with a 200 for a missing .js turns a typo into a
    // confusing MIME error instead of an obvious 404.
    const serve = createStaticHandler(webRoot);
    expect(await serve("/assets/missing.js")).toBeNull();
  });

  test("refuses directory traversal", async () => {
    const serve = createStaticHandler(webRoot);
    expect(await serve("/../etc/passwd")).toBeNull();
    expect(await serve("/assets/../../etc/passwd")).toBeNull();
  });

  test("returns null when the build is absent", async () => {
    const serve = createStaticHandler(join(webRoot, "does-not-exist"));
    expect(await serve("/")).toBeNull();
  });

  test("tolerates a trailing slash on the configured root", async () => {
    const serve = createStaticHandler(`${webRoot}/`);
    expect((await serve("/"))!.status).toBe(200);
  });

  test("per cent-encoded traversal is still refused", async () => {
    const serve = createStaticHandler(webRoot);
    // The caller decodes; encoded dots must not sneak past the check.
    expect(await serve("/%2e%2e/etc/passwd")).toBeNull();
  });
});
