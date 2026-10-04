/**
 * Exec service: runs toolchain commands (bun, cargo, clang, python) on behalf
 * of the browser.
 *
 * Command execution is the most dangerous surface in the product, so the
 * policy — allow-list, argv handling and working-directory sandbox — is pinned
 * here and is fully hermetic.
 *
 * Tests that actually spawn a process are declared with `e2e(...)` and run
 * only via `bun run test:e2e` (see tests/helpers.ts).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecService, allowedBinaries } from "../src/core/exec";
import { SafePathError } from "../src/core/paths";
import { e2e } from "./helpers";

let root: string;
let svc: ExecService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "weber-exec-"));
  svc = new ExecService(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("toolchain registry", () => {
  test("knows the languages Weber advertises", () => {
    const ids = svc.toolchains().map((t) => t.id).sort();
    expect(ids).toEqual(
      ["bun", "cargo", "clang", "clangd", "node", "python", "rustc", "wasmchain"].sort(),
    );
  });

  test("each toolchain reports a display name and a run command", () => {
    for (const t of svc.toolchains()) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(Array.isArray(t.command)).toBe(true);
      expect(t.command.length).toBeGreaterThan(0);
    }
  });

  test("the advertised toolchains are themselves allow-listed", () => {
    // A toolchain we advertise but refuse to run would be a product bug.
    for (const t of svc.toolchains()) {
      expect(allowedBinaries()).toContain(t.command[0]!);
    }
  });
});

describe("ExecService policy — no process is spawned", () => {
  test("refuses a command that is not on the allow-list", () => {
    expect(() => svc.authorize(["curl", "http://example.com"])).toThrow(/not allowed/i);
  });

  test("refuses a binary given as a path", () => {
    // Prevents reaching an unvetted binary by absolute or relative path.
    expect(() => svc.authorize(["/usr/bin/env", "sh"])).toThrow(/bare name/i);
    expect(() => svc.authorize(["..\\evil.exe"])).toThrow(/bare name/i);
    expect(() => svc.authorize(["./run.sh"])).toThrow(/bare name/i);
  });

  test("refuses an empty argv", () => {
    expect(() => svc.authorize([])).toThrow(/empty/i);
  });

  test("refuses an empty or non-string binary", () => {
    expect(() => svc.authorize(["  "])).toThrow(/non-empty/i);
    expect(() => svc.authorize([undefined as unknown as string])).toThrow(/non-empty/i);
  });

  test("refuses NUL bytes anywhere in argv", () => {
    expect(() => svc.authorize(["bun", "-e", "a\u0000b"])).toThrow(/NUL/i);
  });

  test("accepts every allow-listed binary", () => {
    for (const bin of allowedBinaries()) {
      expect(() => svc.authorize([bin])).not.toThrow();
    }
  });

  test("refuses a working directory outside the workspace", () => {
    expect(() => svc.resolveCwd("../outside")).toThrow(SafePathError);
    expect(() => svc.resolveCwd("/etc")).toThrow(SafePathError);
  });

  test("accepts a working directory inside the workspace", () => {
    expect(() => svc.resolveCwd("src/app")).not.toThrow();
    expect(() => svc.resolveCwd("")).not.toThrow();
    expect(() => svc.resolveCwd(undefined)).not.toThrow();
  });
});

describe("ExecService.run — spawns a real process", () => {
  test("the policy is enforced before anything is spawned", async () => {
    // Authorisation happens first, so a rejected command never reaches spawn —
    // which is why this assertion is meaningful even without a spawn.
    await expect(svc.run({ argv: ["curl", "http://example.com"] })).rejects.toThrow(
      /not allowed/i,
    );
    await expect(svc.run({ argv: [] })).rejects.toThrow(/empty/i);
    await expect(svc.run({ argv: ["bun"], cwd: "../escape" })).rejects.toThrow(SafePathError);
  });

  e2e("runs an allowed command and captures stdout", async () => {
    const res = await svc.run({ argv: ["bun", "--version"] });
    expect(res.code).toBe(0);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
  });

  e2e("reports a non-zero exit code without throwing", async () => {
    const res = await svc.run({ argv: ["bun", "-e", "process.exit(3)"] });
    expect(res.code).toBe(3);
  });

  e2e("captures stderr separately from stdout", async () => {
    const res = await svc.run({ argv: ["bun", "-e", "console.error('problem')"] });
    expect(res.stderr).toContain("problem");
    expect(res.stdout).not.toContain("problem");
  });

  e2e("runs in the requested workspace subdirectory", async () => {
    // The directory must exist for the spawn to have a valid cwd.
    mkdirSync(join(root, "sub"), { recursive: true });
    const res = await svc.run({
      argv: ["bun", "-e", "console.log(process.cwd())"],
      cwd: "sub",
    });
    expect(res.stdout.replace(/\\/g, "/")).toContain("sub");
  });

  e2e("enforces a timeout instead of hanging", async () => {
    const res = await svc.run({
      argv: ["bun", "-e", "await new Promise(r => setTimeout(r, 5000))"],
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
  });

  e2e("never interprets arguments through a shell", async () => {
    // A metacharacter must arrive as a literal argument, not be interpreted.
    const res = await svc.run({
      argv: ["bun", "-e", "console.log(process.argv[1])", "a;b"],
    });
    expect(res.stdout).toContain("a;b");
  });

  e2e(
    "probe reports availability for every advertised toolchain",
    async () => {
      const report = await svc.probe();
      for (const t of svc.toolchains()) {
        expect(report[t.id]).toBeDefined();
        expect(typeof report[t.id]!.available).toBe("boolean");
      }
      // Bun is the runtime we are already inside, so it must be present.
      expect(report["bun"]!.available).toBe(true);
    },
    // probing spawns one process per toolchain; on a busy CI runner the
    // default 5s is not enough for eight of them.
    30_000,
  );
});
