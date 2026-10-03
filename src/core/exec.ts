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
const EXEC_SUFFIXES = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

export const TOOLCHAINS: Toolchain[] = [
  { id: "bun", label: "Bun / TypeScript", command: ["bun", "--version"], binaries: ["bun"] },
  { id: "node", label: "Node.js", command: ["node", "--version"], binaries: ["node"] },
  { id: "rustc", label: "Rust compiler", command: ["rustc", "--version"], binaries: ["rustc"] },
  { id: "cargo", label: "Cargo", command: ["cargo", "--version"], binaries: ["cargo"] },
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
    binaries: ["python", "python3"],
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
      let child;
      try {
        child = spawn(bin, options.argv.slice(1), {
          cwd,
          // No shell: arguments stay data and cannot be re-interpreted.
          shell: false,
          windowsHide: true,
          env: { ...process.env, ...options.env },
        });
      } catch (err) {
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
        for (const candidate of candidateCommands(t)) {
          if (!ALLOWED_BINARIES.has(candidate[0]!)) continue;
          try {
            const res = await this.run({ argv: candidate, timeoutMs: 10_000 });
            if (res.code === 0) {
              report[t.id] = {
                available: true,
                version: (res.stdout || res.stderr).trim().split("\n")[0],
              };
              return;
            }
          } catch {
            // fall through to the next candidate
          }
        }
        report[t.id] = { available: false, error: "not installed in this image" };
      }),
    );
    return report;
  }
}

/** A toolchain may be satisfied by any of several binaries (python/python3). */
function candidateCommands(t: Toolchain): string[][] {
  return t.binaries
    .filter((b) => b !== "wasmchain" || true)
    .map((bin) => [bin, ...t.command.slice(1)]);
}

/** Exported for tests and for the API's capability listing. */
export function allowedBinaries(): string[] {
  return [...ALLOWED_BINARIES].sort();
}

export { EXEC_SUFFIXES };
