/**
 * Bun version and lockfile compatibility.
 *
 * Found by the first real image build: CI failed with
 *
 *   error: Unknown lockfile version
 *   UnknownLockfileVersion: failed to parse lockfile: 'bun.lock'
 *
 * The lockfile was written by Bun 1.4.2 (lockfileVersion 2) while the images
 * were pinned to oven/bun:1.3, which cannot parse it. Nothing caught this
 * locally because the local Bun is 1.4.2 and the images had never been built.
 *
 * The lesson generalises: a pinned base image and a floating local toolchain
 * drift apart, and the failure appears only at build time in someone else's
 * environment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

const DOCKERFILES = [
  "compose/Dockerfile.core",
  "compose/Dockerfile.web",
  "deploy/paas/Dockerfile",
];

/** Every `oven/bun:<tag>` a Dockerfile uses. */
function bunTags(src: string): string[] {
  return [...src.matchAll(/FROM\s+oven\/bun:([^\s]+)/g)].map((m) => m[1]!);
}

/** Major.minor of a tag like `1.3-alpine`. */
function minorOf(tag: string): string {
  const m = tag.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : "";
}

describe("bun base image consistency", () => {
  test("every Dockerfile pins the same Bun minor version", () => {
    // Two images built from different Bun minors would produce different
    // lockfile handling and different runtime behaviour.
    const minors = new Set<string>();
    for (const df of DOCKERFILES) {
      for (const tag of bunTags(read(df))) minors.add(minorOf(tag));
    }
    expect(minors.size).toBe(1);
  });

  test("the lockfile version is parseable by the pinned Bun", () => {
    // Bun 1.3 understands lockfileVersion 1; version 2 arrived later. A
    // mismatch is an immediate build failure inside the image.
    if (!exists("bun.lock")) return;
    // bun.lock is JSONC: it carries comments and trailing commas, so
    // JSON.parse is not usable. Read the field directly.
    const header = read("bun.lock").slice(0, 200);
    const version = Number(header.match(/"lockfileVersion"\s*:\s*(\d+)/)?.[1] ?? 0);
    expect(version).toBeGreaterThan(0);

    const pinned = minorOf(bunTags(read(DOCKERFILES[0]!))[0]!);
    const [major, minor] = pinned.split(".").map(Number);

    if (version >= 2) {
      // A v2 lockfile needs Bun >= 1.4 in the image, or the build fails with
      // "Unknown lockfile version" before anything else runs.
      expect(`${pinned}:${major === 1 && (minor ?? 0) < 4}`).toBe(`${pinned}:false`);
    }
  });
});

describe("install robustness", () => {
  test("every Dockerfile can install without a lockfile", () => {
    // A frozen-lockfile-only install turns a lockfile format change into a
    // hard build failure with no way through.
    for (const df of DOCKERFILES) {
      expect(`${df}:${/bun install[^\n]*\|\|\s*bun install/.test(read(df))}`).toBe(`${df}:true`);
    }
  });

  test("no Dockerfile copies the lockfile without a fallback", () => {
    for (const df of DOCKERFILES) {
      const src = read(df);
      if (!/COPY[^\n]*bun\.lock/.test(src)) continue;
      // The glob form is required: `bun.lock*` tolerates the file being
      // absent, while a bare `bun.lock` fails the COPY outright.
      expect(`${df}:${/bun\.lock\*/.test(src)}`).toBe(`${df}:true`);
    }
  });
});
