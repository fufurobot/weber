/**
 * Path sandbox: every filesystem request arrives as an untrusted relative
 * string from the browser, so resolution must be provably inside the root.
 */
import { describe, expect, test } from "bun:test";
import { resolveInRoot, isInsideRoot, SafePathError } from "../src/core/paths";

const ROOT = process.platform === "win32" ? "C:\\ws" : "/ws";

describe("resolveInRoot", () => {
  test("joins a simple relative path", () => {
    expect(resolveInRoot(ROOT, "src/main.ts")).toBe(
      process.platform === "win32" ? "C:\\ws\\src\\main.ts" : "/ws/src/main.ts",
    );
  });

  test("treats the empty path and '.' as the root itself", () => {
    expect(resolveInRoot(ROOT, "")).toBe(ROOT);
    expect(resolveInRoot(ROOT, ".")).toBe(ROOT);
  });

  test("normalises redundant separators and interior '..'", () => {
    expect(resolveInRoot(ROOT, "a/./b/../c")).toBe(
      process.platform === "win32" ? "C:\\ws\\a\\c" : "/ws/a/c",
    );
  });

  test("rejects any attempt to escape the root", () => {
    for (const evil of ["../etc/passwd", "a/../../b", "..", "../../..", "a/b/../../../.."]) {
      expect(() => resolveInRoot(ROOT, evil)).toThrow(SafePathError);
    }
  });

  test("rejects absolute paths", () => {
    for (const evil of ["/etc/passwd", "C:\\Windows\\system32", "\\\\server\\share"]) {
      expect(() => resolveInRoot(ROOT, evil)).toThrow(SafePathError);
    }
  });

  test("rejects NUL bytes", () => {
    expect(() => resolveInRoot(ROOT, "a\u0000b")).toThrow(SafePathError);
  });

  test("allows a sibling directory whose name merely starts with '..'", () => {
    // '..foo' must not be treated as a traversal.
    expect(() => resolveInRoot(ROOT, "..foo/bar")).not.toThrow();
  });

  test("treats escaped backslashes as separators on every platform", () => {
    expect(() => resolveInRoot(ROOT, "..\\..\\windows")).toThrow(SafePathError);
  });
});

describe("isInsideRoot", () => {
  test("is true for the root and its descendants", () => {
    const child = process.platform === "win32" ? "C:\\ws\\a\\b" : "/ws/a/b";
    expect(isInsideRoot(ROOT, ROOT)).toBe(true);
    expect(isInsideRoot(ROOT, child)).toBe(true);
  });

  test("is false for a sibling with a shared prefix", () => {
    const sibling = process.platform === "win32" ? "C:\\ws-evil" : "/ws-evil";
    expect(isInsideRoot(ROOT, sibling)).toBe(false);
  });

  test("is false for an unrelated absolute path", () => {
    const other = process.platform === "win32" ? "C:\\other" : "/other";
    expect(isInsideRoot(ROOT, other)).toBe(false);
  });
});
