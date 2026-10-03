/**
 * File service: the API surface Project Mode depends on.
 * Every method must refuse to operate outside the workspace root.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileService } from "../src/core/files";
import { SafePathError } from "../src/core/paths";

let root: string;
let svc: FileService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "weber-files-"));
  svc = new FileService(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FileService.read/write", () => {
  test("round-trips a file", async () => {
    await svc.write("hello.txt", "hi there");
    expect(await svc.read("hello.txt")).toBe("hi there");
  });

  test("creates intermediate directories on write", async () => {
    await svc.write("a/b/c/deep.txt", "x");
    expect(await svc.read("a/b/c/deep.txt")).toBe("x");
  });

  test("overwrites an existing file", async () => {
    await svc.write("f.txt", "one");
    await svc.write("f.txt", "two");
    expect(await svc.read("f.txt")).toBe("two");
  });

  test("refuses to read or write outside the root", async () => {
    await expect(svc.read("../escape.txt")).rejects.toThrow(SafePathError);
    await expect(svc.write("../escape.txt", "x")).rejects.toThrow(SafePathError);
  });

  test("reports a missing file as a distinct error", async () => {
    await expect(svc.read("nope.txt")).rejects.toThrow(/not found/i);
  });
});

describe("FileService.list", () => {
  test("lists a directory with names and kinds", async () => {
    await svc.write("src/main.ts", "");
    await svc.write("README.md", "");
    const entries = await svc.list("");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["README.md", "src"]);
    expect(entries.find((e) => e.name === "src")!.kind).toBe("directory");
    expect(entries.find((e) => e.name === "README.md")!.kind).toBe("file");
  });

  test("sorts directories before files", async () => {
    await svc.write("z.txt", "");
    await svc.write("a/inner.txt", "");
    const entries = await svc.list("");
    expect(entries[0]!.kind).toBe("directory");
  });

  test("hides dotfiles by default but shows them on request", async () => {
    await svc.write(".hidden", "");
    await svc.write("visible", "");
    expect((await svc.list("")).map((e) => e.name)).toEqual(["visible"]);
    expect((await svc.list("", { showHidden: true })).map((e) => e.name).sort()).toEqual([
      ".hidden",
      "visible",
    ]);
  });

  test("refuses to list outside the root", async () => {
    await expect(svc.list("../")).rejects.toThrow(SafePathError);
  });
});

describe("FileService.remove/rename/mkdir", () => {
  test("removes a file", async () => {
    await svc.write("gone.txt", "x");
    await svc.remove("gone.txt");
    await expect(svc.read("gone.txt")).rejects.toThrow(/not found/i);
  });

  test("renames a file", async () => {
    await svc.write("old.txt", "payload");
    await svc.rename("old.txt", "new.txt");
    expect(await svc.read("new.txt")).toBe("payload");
  });

  test("makes a directory", async () => {
    await svc.mkdir("fresh/dir");
    expect((await svc.list("fresh")).map((e) => e.name)).toEqual(["dir"]);
  });

  test("refuses destructive operations outside the root", async () => {
    await expect(svc.remove("../x")).rejects.toThrow(SafePathError);
    await expect(svc.rename("../x", "y")).rejects.toThrow(SafePathError);
    await expect(svc.mkdir("../x")).rejects.toThrow(SafePathError);
  });

  test("refuses to delete the root itself", async () => {
    await expect(svc.remove(".")).rejects.toThrow(/root/i);
  });
});

describe("FileService.search", () => {
  test("finds files by substring, ignoring case", async () => {
    await svc.write("src/MainComponent.tsx", "");
    await svc.write("src/other.ts", "");
    const hits = await svc.search("maincomp");
    expect(hits).toEqual(["src/MainComponent.tsx"]);
  });

  test("never escapes the root", async () => {
    const outside = join(root, "..", "outside-weber-search.txt");
    writeFileSync(outside, "x");
    try {
      const hits = await svc.search("outside-weber-search");
      expect(hits).toEqual([]);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("FileService.stat", () => {
  test("reports size and modification time", async () => {
    await svc.write("s.txt", "12345");
    const st = await svc.stat("s.txt");
    expect(st.size).toBe(5);
    expect(st.mtime).toBeGreaterThan(0);
    expect(st.kind).toBe("file");
  });

  test("rejects a path outside the root", async () => {
    await expect(svc.stat("../x")).rejects.toThrow(SafePathError);
  });
});

describe("FileService.projectRoots", () => {
  test("treats a directory containing .git as a project root", async () => {
    await svc.write("proj-a/.git/HEAD", "ref: refs/heads/main");
    await svc.write("proj-a/src/index.ts", "");
    await svc.write("loose.txt", "");
    const roots = await svc.findProjectRoots();
    expect(roots).toContain("proj-a");
    expect(roots).not.toContain("loose.txt");
  });

  test("treats a package.json as a project root too", async () => {
    mkdirSync(join(root, "proj-b"), { recursive: true });
    writeFileSync(join(root, "proj-b", "package.json"), "{}");
    const roots = await svc.findProjectRoots();
    expect(roots).toContain("proj-b");
  });
});
