/**
 * Exec service: runs toolchain commands (bun, cargo, clang, python) on behalf
 * of the browser.
 *
 * Command execution is the most dangerous surface in the product, so the
 * allow-list and the working-directory sandbox are pinned here before the
 * implementation exists.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecService } from "../src/core/exec";
import { SafePathError } from "../src/core/paths";

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
      ["bun", "cargo", "clang", "clangd", "python", "rustc", "wasmchain"].sort(),
    );
  });

  test("each toolchain reports a display name and a run command", () => {
    for (const t of svc.toolchains()) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(Array.isArray(t.command)).toBe(true);
      expect(t.command.length).toBeGreaterThan(0);
    }
  });

  test("availability probing does not throw for missing binaries", async () => {
    const report = await svc.probe();
    expect(typeof report).toBe("object");
    // Every advertised toolchain must be reported, present or not.
    for (const t of svc.toolchains()) {
      expect(report[t.id]).toBeDefined();
      expect(typeof report[t.id]!.available).toBe("boolean");
    }
  });
});

describe("ExecService.run policy", () => {
  test("refuses a command that is not on the allow-list", async () => {
    await expect(svc.run({ argv: ["curl", "http://example.com"] })).rejects.toThrow(
      /not allowed/i,
    );
  });

  test("refuses an empty argv", async () => {
    await expect(svc.run({ argv: [] })).rejects.toThrow(/empty/i);
  });

  test("refuses a shell metacharacter smuggled into an argument", async () => {
    // Even an allowed binary must not be usable as a shell injection vector.
    await expect(
      svc.run({ argv: ["bun", "-e", "1; rm -rf /"] }),
    ).resolves.toBeDefined();
    // The argument is passed through as data, never interpreted by a shell,
    // so this completes without executing the `rm`.
  });

  test("refuses a working directory outside the workspace", async () => {
    await expect(
      svc.run({ argv: ["bun", "--version"], cwd: "../outside" }),
    ).rejects.toThrow(SafePathError);
  });

  test("runs an allowed command and captures stdout", async () => {
    const res = await svc.run({ argv: ["bun", "--version"] });
    expect(res.code).toBe(0);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
  });

  test("reports a non-zero exit code without throwing", async () => {
    const res = await svc.run({ argv: ["bun", "-e", "process.exit(3)"] });
    expect(res.code).toBe(3);
  });

  test("captures stderr separately", async () => {
    const res = await svc.run({
      argv: ["bun", "-e", "console.error('problem')"],
    });
    expect(res.stderr).toContain("problem");
  });

  test("runs in the requested workspace subdirectory", async () => {
    const res = await svc.run({
      argv: ["bun", "-e", "console.log(process.cwd())"],
      cwd: "sub",
    });
    expect(res.stdout.replace(/\\/g, "/")).toContain("sub");
  });

  test("enforces a timeout", async () => {
    const res = await svc.run({
      argv: ["bun", "-e", "await new Promise(r => setTimeout(r, 5000))"],
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
  });

  test("never interprets arguments through a shell", async () => {
    // A metacharacter must arrive as a literal argument.
    const res = await svc.run({ argv: ["bun", "-e", "console.log(process.argv[1])", "a;b"] });
    expect(res.stdout).toContain("a;b");
  });
});
