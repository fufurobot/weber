/**
 * Exec service — runs toolchain commands for the terminal and build tasks.
 *
 * Two rules make this safe enough to expose:
 *   1. argv is an array, never a command string, and is spawned without a
 *      shell, so metacharacters are data rather than instructions.
 *   2. the working directory is resolved through the same path sandbox as the
 *      file service, so a request cannot walk out of the workspace.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { resolveInRoot } from "./paths";

export interface Toolchain {
  id: string;
  label: string;
  /** Base command used for a "run" action. */
  command: string[];
  /** Other binaries this toolchain expects on PATH. */
  binaries: string[];
}

export interface ToolchainStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export interface RunOptions {
  argv: string[];
  /** Workspace-relative directory to run in. Defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Nothing outside this set may be executed, whatever the request says. */
const ALLOWED_BINARIES = new Set([
  "bun",
  "bunx",
  "node",
  "tsc",
  "cargo",
  "rustc",
  "rustup",
  "wasm-pack",
  "clang",
  "clang++",
  "clangd",
  "wasmchain",
  "wasm-ld",
  "lld",
  "python",
  "python3",
  "uv",
  "uvx",
  "git",
  "ls",
  "dir",
  "cat",
  "pwd",
  "echo",
]);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/** Windows resolves executables through these; POSIX needs no suffix. */
const EXEC_SUFFIXES = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

/** Final path components that must never be selected as a target. */
const SCRIPT_SHIM_SUFFIXES = process.platform === "win32" ? [".cmd", ".bat"] : [];

/**
 * Resolve an allow-listed bare name to an absolute executable path.
 *
 * On Windows a bare name on PATH is often a *shim*: `bun.cmd` is a batch file
 * and an extensionless `bun` is a `/bin/sh` script. Spawning either forces the
 * runtime to route through cmd.exe (or a shell), which then rejects arguments
 * containing metacharacters such as `;`, `(`, `)` and `&`. That would make
 * safe, allow-listed commands fail seemingly at random, so only a genuine
 * native executable is accepted.
 *
 * Resolution never widens the allow-list: the caller has already authorised
 * `bin`, and this only chooses *which* file satisfies it.
 */
export function resolveExecutable(bin: string): string | null {
  const search = (names: string[]): string | null => {
    const pathVar = process.env.PATH ?? process.env.Path ?? "";
    const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
    for (const name of names) {
      for (const dir of dirs) {
        const candidate = join(dir, name);
        try {
          accessSync(candidate, constants.X_OK);
          return candidate;
        } catch {
          // not here; keep looking
        }
      }
    }
    return null;
  };

  if (process.platform !== "win32") return search([bin]);

  // Native first: `foo.exe`. Anything else would need a shell to run.
  const native = search([`${bin}.exe`]);
  if (native) return native;

  // No native binary on PATH. For the runtime we are already running inside,
  // its own executable is strictly better than a batch or sh shim.
  const self = selfExecutableFor(bin);
  if (self) {
    try {
      accessSync(self, constants.X_OK);
      return self;
    } catch {
      // fall through
    }
  }

  // Last resort: a shim, which run() will refuse rather than execute unsafely.
  return search([`${bin}.cmd`, `${bin}.bat`]);
}

/** True when this resolved path needs cmd.exe to run (a batch shim). */
export function isScriptShim(path: string): boolean {
  return SCRIPT_SHIM_SUFFIXES.some((s) => path.toLowerCase().endsWith(s));
}

/**
 * The interpreter's own binary, when it is a better answer than PATH.
 *
 * On Windows `bun` is installed as `bun.cmd`, and Bun's real executable lives
 * in its lib directory rather than on PATH. Running the real binary avoids
 * cmd.exe entirely, which is what makes arbitrary arguments safe.
 */
function selfExecutableFor(bin: string): string | null {
  for (const key of ["bun", "node"] as const) {
    if (bin !== key) continue;
    const execPath = process.execPath;
    if (!execPath) return null;
    // process.execPath is the interpreter running THIS process: prefer it when
    // the requested binary is that same runtime.
    const base = execPath.toLowerCase();
    if (key === "bun" && base.includes("bun")) return execPath;
    if (key === "node" && base.includes("node")) return execPath;
  }
  return null;
}

export const TOOLCHAINS: Toolchain[] = [
  { id: "bun", label: "Bun / TypeScript", command: ["bun", "--version"], binaries: ["bun"] },
  { id: "node", label: "Node.js", command: ["node", "--version"], binaries: ["node"] },
  { id: "rustc", label: "Rust compiler", command: ["rustc", "--version"], binaries: ["rustc"] },
  { id: "cargo", label: "Cargo", command: ["cargo", "--version"], binaries: ["cargo"] },
  // clang, clangd and wasmchain answer to `--version`; llvm tools generally do,
  // but rustc/cargo accept it too. Kept explicit so probing stays testable.
  { id: "clang", label: "Clang C/C++", command: ["clang", "--version"], binaries: ["clang"] },
  { id: "clangd", label: "clangd LSP", command: ["clangd", "--version"], binaries: ["clangd"] },
  {
    id: "wasmchain",
    label: "wasmchain",
    command: ["wasmchain", "--version"],
    binaries: ["wasmchain"],
  },
  {
    id: "python",
    label: "Python (Pyodide in-browser, CPython for builds)",
    command: ["python", "--version"],
    binaries: ["python3", "python"],
  },
];

export class ExecService {
  constructor(private readonly root: string) {}

  toolchains(): Toolchain[] {
    return TOOLCHAINS.map((t) => ({ ...t, command: [...t.command], binaries: [...t.binaries] }));
  }

  resolveCwd(rel: string | undefined): string {
    if (!rel) return resolveInRoot(this.root, ".");
    return resolveInRoot(this.root, rel);
  }

  /** Validate a request without running it; throws on policy violations. */
  authorize(argv: string[]): string {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("argv must not be empty");
    }
    const bin = argv[0]!;
    if (typeof bin !== "string" || bin.trim() === "") {
      throw new Error("argv[0] must be a non-empty string");
    }
    if (bin.includes("/") || bin.includes("\\")) {
      throw new Error(`binary must be a bare name, not a path: ${bin}`);
    }
    if (!ALLOWED_BINARIES.has(bin)) {
      throw new Error(
        `command not allowed: ${bin}. Allowed: ${[...ALLOWED_BINARIES].sort().join(", ")}`,
      );
    }
    // NUL bytes would truncate the argv entry inside the OS call.
    for (const arg of argv) {
      if (typeof arg !== "string" || arg.includes("\u0000")) {
        throw new Error("argv entries must be strings without NUL bytes");
      }
    }
    return bin;
  }

  /** Run a command in the workspace, capturing bounded output. */
  async run(options: RunOptions): Promise<RunResult> {
    const bin = this.authorize(options.argv);
    const cwd = this.resolveCwd(options.cwd);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    return await new Promise<RunResult>((resolve, reject) => {
      // Spawn a resolved native executable so batch/sh shims are avoided; a
      // shim would force a shell, which defeats argv-as-data.
      const resolved = resolveExecutable(bin);
      if (resolved && isScriptShim(resolved)) {
        resolve({
          code: 126,
          stdout: "",
          stderr:
            `${bin}: only a shell script shim is installed at ${resolved}. ` +
            `Weber runs commands without a shell, so a native executable is required.`,
          timedOut: false,
          durationMs: Date.now() - started,
        });
        return;
      }
      const target = resolved ?? bin;
      let child;
      try {
        child = spawn(target, options.argv.slice(1), {
          cwd,
          // No shell: arguments stay data and cannot be re-interpreted.
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...options.env },
        });
      } catch (err) {
        // Bun may throw the refusal synchronously rather than emitting it.
        const refusal = spawnRefusal(err, bin);
        if (refusal) {
          resolve({ ...refusal, durationMs: Date.now() - started });
          return;
        }
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const cap = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_OUTPUT_BYTES) return current;
        const next = current + chunk.toString("utf8");
        return next.length > MAX_OUTPUT_BYTES ? next.slice(0, MAX_OUTPUT_BYTES) : next;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = cap(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = cap(stderr, chunk);
      });

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          resolve({
            code: 127,
            stdout,
            stderr: `${stderr}${bin}: command not found`,
            timedOut: false,
            durationMs: Date.now() - started,
          });
          return;
        }
        // The OS refused to start the process at all. This is an environment
        // condition, not a bad request, so surface it as a result the caller
        // can explain rather than as an opaque internal error.
        const refusal = spawnRefusal(err, bin);
        if (refusal) {
          resolve({ ...refusal, stdout, stderr: stderr + refusal.stderr, durationMs: Date.now() - started });
          return;
        }
        reject(err);
      });
      child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    });
  }

  /**
   * Probe every advertised toolchain.
   *
   * A missing binary is a normal state (the image ships only some of them) and
   * must be reported, not thrown.
   */
  async probe(): Promise<Record<string, ToolchainStatus>> {
    const report: Record<string, ToolchainStatus> = {};
    await Promise.all(
      TOOLCHAINS.map(async (t) => {
        // A toolchain may be satisfied by any of several binaries (python3 vs
        // python), so try each in order and report the first that answers.
        for (const bin of t.binaries) {
          if (!ALLOWED_BINARIES.has(bin)) continue;
          try {
            const res = await this.run({ argv: [bin, ...t.command.slice(1)], timeoutMs: 10_000 });
            const text = (res.stdout || res.stderr).trim();
            // A missing binary is reported by run() as exit 127 with a
            // "command not found" line, which must NOT count as available.
            if (res.code === 127 || /command not found/i.test(text)) continue;
            if (res.code === 0 || text.length > 0) {
              report[t.id] = { available: true, version: text.split("\n")[0] };
              return;
            }
          } catch {
            // try the next candidate
          }
        }
        report[t.id] = { available: false, error: "not installed in this image" };
      }),
    );
    return report;
  }
}

/**
 * Translate an OS-level refusal to start a process into a runnable result.
 *
 * A sandbox (container, seccomp profile, Windows job object) may deny process
 * creation outright. That is an environment condition rather than a bad
 * request, so it must reach the caller as an explainable exit code instead of
 * an opaque 500 that hides why nothing happened.
 *
 * Returns null for unrelated errors, which should still throw.
 */
function spawnRefusal(
  err: unknown,
  bin: string,
): { code: number; stdout: string; stderr: string; timedOut: boolean } | null {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code !== "EPERM" && code !== "EACCES") return null;
  return {
    code: 126,
    stdout: "",
    stderr:
      `${bin}: the operating system refused to start this process (${code}). ` +
      `If this service runs inside a sandbox, process execution may be restricted here.`,
    timedOut: false,
  };
}

/** Exported for tests and for the API's capability listing. */
export function allowedBinaries(): string[] {
  return [...ALLOWED_BINARIES].sort();
}

export { EXEC_SUFFIXES };
