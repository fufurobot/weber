/**
 * Workspace registry: the mapping from an authenticated user to the directory
 * their work lives in.
 *
 * This is the foundation of multi-user hosting. Even before any privilege
 * separation exists, two invariants must hold, and both are the kind of thing
 * that is silently wrong rather than loudly broken:
 *
 *   1. a user can only ever resolve their own workspace
 *   2. a GitHub login cannot become a path that escapes the users root
 *
 * The second is the interesting one: `login` is attacker-controlled (anyone
 * can register a GitHub account), so it must never be interpolated into a
 * filesystem path without validation.
 */
import { describe, expect, test } from "bun:test";
import { WorkspaceRegistry, InvalidLoginError } from "../src/core/tenancy";

const ROOT = process.platform === "win32" ? "C:\\users-root" : "/users-root";

describe("login validation", () => {
  test("accepts ordinary GitHub logins", () => {
    const reg = new WorkspaceRegistry(ROOT);
    for (const login of ["fufurobot", "octocat", "a", "user-name", "user123"]) {
      expect(() => reg.workspaceFor(login)).not.toThrow();
    }
  });

  test("is case-insensitive, so FufuRobot and fufurobot share one workspace", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(reg.workspaceFor("FufuRobot")).toBe(reg.workspaceFor("fufurobot"));
  });

  test("rejects traversal attempts", () => {
    const reg = new WorkspaceRegistry(ROOT);
    for (const evil of ["..", "../etc", "../../root", "a/../../b", "./.."]) {
      expect(() => reg.workspaceFor(evil)).toThrow(InvalidLoginError);
    }
  });

  test("rejects separators and absolute paths", () => {
    const reg = new WorkspaceRegistry(ROOT);
    for (const evil of ["a/b", "a\\b", "/etc/passwd", "C:\\Windows", "\\\\server\\share"]) {
      expect(() => reg.workspaceFor(evil)).toThrow(InvalidLoginError);
    }
  });

  test("rejects leading dots and dashes that could impersonate system entries", () => {
    const reg = new WorkspaceRegistry(ROOT);
    for (const evil of [".", ".hidden", "-flag", "_underscore"]) {
      expect(() => reg.workspaceFor(evil)).toThrow(InvalidLoginError);
    }
  });

  test("rejects NUL bytes and control characters", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(() => reg.workspaceFor("a\u0000b")).toThrow(InvalidLoginError);
    expect(() => reg.workspaceFor("a\nb")).toThrow(InvalidLoginError);
  });

  test("rejects empty and over-long logins", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(() => reg.workspaceFor("")).toThrow(InvalidLoginError);
    expect(() => reg.workspaceFor("   ")).toThrow(InvalidLoginError);
    expect(() => reg.workspaceFor("a".repeat(40))).toThrow(InvalidLoginError);
  });

  test("accepts a login at exactly GitHub's maximum length", () => {
    // GitHub caps logins at 39 characters; rejecting that length would break
    // real users.
    const reg = new WorkspaceRegistry(ROOT);
    expect(() => reg.workspaceFor("a".repeat(39))).not.toThrow();
  });

  test("the resolved workspace always stays under the users root", () => {
    const reg = new WorkspaceRegistry(ROOT);
    const ws = reg.workspaceFor("fufurobot");
    expect(ws.startsWith(ROOT.replace(/\\/g, "/")) || ws.startsWith(ROOT)).toBe(true);
    expect(ws).toContain("fufurobot");
  });
});

describe("workspace resolution", () => {
  test("is stable for the same user", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(reg.workspaceFor("fufurobot")).toBe(reg.workspaceFor("fufurobot"));
  });

  test("differs between users", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(reg.workspaceFor("alice")).not.toBe(reg.workspaceFor("bob"));
  });

  test("two users never resolve to a nested path of the other", () => {
    // 'a' and 'a-b' must not collide via prefix matching.
    const reg = new WorkspaceRegistry(ROOT);
    const a = reg.workspaceFor("a").replace(/\\/g, "/");
    const ab = reg.workspaceFor("a-b").replace(/\\/g, "/");
    expect(ab.startsWith(`${a}/`)).toBe(false);
  });

  test("exposes the owner UID assigned to a user", () => {
    const reg = new WorkspaceRegistry(ROOT, { baseUid: 20000 });
    const uid = reg.uidFor("fufurobot");
    expect(uid).toBeGreaterThanOrEqual(20000);
    // Stable and collision-free across users.
    expect(reg.uidFor("fufurobot")).toBe(uid);
    expect(reg.uidFor("octocat")).not.toBe(uid);
  });

  test("UID assignment is deterministic, not order-dependent", () => {
    const a = new WorkspaceRegistry(ROOT, { baseUid: 20000 });
    const b = new WorkspaceRegistry(ROOT, { baseUid: 20000 });
    expect(a.uidFor("alice")).toBe(b.uidFor("alice"));
  });

  test("reports whether a login is a valid workspace owner", () => {
    const reg = new WorkspaceRegistry(ROOT);
    expect(reg.isValidLogin("fufurobot")).toBe(true);
    expect(reg.isValidLogin("../evil")).toBe(false);
  });
});
