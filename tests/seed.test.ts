/**
 * Starter workspace seeding.
 *
 * Issue #8: a first-time user opens an empty IDE with no indication of what to
 * do. Seeding is easy; *not destroying a real workspace* is the part worth
 * pinning down first, because a bug there silently overwrites someone's work.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedStarterWorkspace, STARTER_FILES } from "../src/core/seed";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "weber-seed-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("seedStarterWorkspace", () => {
  test("seeds an empty workspace and reports what it wrote", async () => {
    const result = await seedStarterWorkspace(root);
    expect(result.seeded).toBe(true);
    expect(result.written.length).toBeGreaterThan(0);
  });

  test("writes every declared starter file", async () => {
    await seedStarterWorkspace(root);
    for (const rel of Object.keys(STARTER_FILES)) {
      expect(existsSync(join(root, rel))).toBe(true);
    }
  });

  test("creates nested directories as needed", async () => {
    await seedStarterWorkspace(root);
    const nested = Object.keys(STARTER_FILES).filter((f) => f.includes("/"));
    expect(nested.length).toBeGreaterThan(0);
    for (const rel of nested) expect(existsSync(join(root, rel))).toBe(true);
  });

  test("never overwrites an existing file", async () => {
    const target = Object.keys(STARTER_FILES)[0]!;
    mkdirSync(join(root, target, ".."), { recursive: true });
    writeFileSync(join(root, target), "MY PRECIOUS WORK");

    const result = await seedStarterWorkspace(root);

    expect(readFileSync(join(root, target), "utf8")).toBe("MY PRECIOUS WORK");
    expect(result.written).not.toContain(target);
  });

  test("does nothing at all when the workspace is not empty", async () => {
    writeFileSync(join(root, "user-file.txt"), "already here");

    const result = await seedStarterWorkspace(root);

    expect(result.seeded).toBe(false);
    expect(result.written).toEqual([]);
    // Crucially, it must not add a single starter file.
    for (const rel of Object.keys(STARTER_FILES)) {
      expect(existsSync(join(root, rel))).toBe(false);
    }
  });

  test("treats a workspace containing only empty directories as non-empty", async () => {
    mkdirSync(join(root, "empty-dir"), { recursive: true });
    // A directory the user made is still intent; seeding into it is surprising.
    const result = await seedStarterWorkspace(root);
    expect(result.seeded).toBe(false);
  });

  test("seeds when the workspace does not exist yet", async () => {
    const missing = join(root, "brand-new");
    const result = await seedStarterWorkspace(missing);
    expect(result.seeded).toBe(true);
    expect(existsSync(join(missing, "README.md"))).toBe(true);
  });

  test("is idempotent: a second call changes nothing", async () => {
    const first = await seedStarterWorkspace(root);
    expect(first.seeded).toBe(true);

    const second = await seedStarterWorkspace(root);
    expect(second.seeded).toBe(false);
    expect(second.written).toEqual([]);
  });

  test("can be forced to seed even into a non-empty workspace", async () => {
    writeFileSync(join(root, "user-file.txt"), "x");
    const result = await seedStarterWorkspace(root, { force: true });
    expect(result.seeded).toBe(true);
    // Force must still not clobber existing files.
    writeFileSync(join(root, "README.md"), "MINE");
    await seedStarterWorkspace(root, { force: true });
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("MINE");
  });

  test("the starter content is not empty and mentions the two modes", async () => {
    await seedStarterWorkspace(root);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme.length).toBeGreaterThan(50);
    expect(readme.toLowerCase()).toContain("project mode");
    expect(readme.toLowerCase()).toContain("script mode");
  });

  test("ships at least one file per advertised language", () => {
    const names = Object.keys(STARTER_FILES).join(" ");
    expect(names).toMatch(/\.ts$/m);
    expect(names).toMatch(/\.rs$/m);
    expect(names).toMatch(/\.c(pp)?$/m);
    expect(names).toMatch(/\.py$/m);
  });

  test("seeded content contains no secrets or absolute paths", () => {
    for (const [name, content] of Object.entries(STARTER_FILES)) {
      expect(content).not.toMatch(/github_pat_|BEGIN [A-Z ]*PRIVATE KEY/);
      // A starter must not leak the machine it was authored on.
      expect(content).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]+\//);
      if (name.endsWith(".ts")) expect(content.length).toBeGreaterThan(0);
    }
  });
});
