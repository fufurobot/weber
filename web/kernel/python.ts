/**
 * Pyodide notebook runtime.
 *
 * Script Mode runs TypeScript in the browser today. Python is what the README
 * promises and what Pyodide actually delivers: a real WASM CPython, with the
 * caveats documented in `src/core/python.ts`.
 *
 * The constraint that shapes everything: **Pyodide is loaded lazily**. It is
 * ~6.4 MB and takes seconds to initialise, so a user who only wants TypeScript
 * must never pay for it. That is why this owns a state machine rather than a
 * bare `getPyodide()`.
 */

export type KernelStatus = "idle" | "loading" | "ready" | "running" | "error";

export interface CellOutput {
  /** Text written to stdout by this cell. */
  stdout: string;
  /** Text written to stderr, including warnings. */
  stderr: string;
  /** The value of the final expression, if the cell has one. */
  result?: unknown;
  /** A traceback, when the cell raised. */
  error?: string;
}

/** The subset of the Pyodide API this module needs. */
export interface PyodideLike {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  loadPackagesFromImports?(code: string): Promise<void>;
}

export interface KernelOptions {
  /** Injected, so tests never download 6 MB and the CDN can be swapped. */
  load: () => Promise<PyodideLike>;
  /** Auto-install imported packages. Off by default: it is a network call. */
  autoLoadPackages?: boolean;
}

/**
 * A single Python kernel for the lifetime of the page.
 *
 * State is deliberately *not* reset between cells: a notebook's whole point is
 * that a later cell can use what an earlier one defined.
 */
export class PythonKernel {
  private status: KernelStatus = "idle";
  private pyodide: PyodideLike | null = null;
  private loading: Promise<PyodideLike> | null = null;
  /** Serialises runs, so output is never attributed to the wrong cell. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The cell currently running, if any. */
  private current: { stdout: string[]; stderr: string[] } | null = null;

  constructor(private readonly options: KernelOptions) {}

  getStatus(): KernelStatus {
    return this.status;
  }

  /** Load the runtime. Idempotent and safe under concurrent callers. */
  async load(): Promise<PyodideLike> {
    if (this.pyodide) return this.pyodide;
    // Two cells could both trigger a load; only one fetch should happen.
    if (this.loading) return this.loading;

    this.status = "loading";
    this.loading = this.options
      .load()
      .then((runtime) => {
        this.attachSinks(runtime);
        this.pyodide = runtime;
        this.status = "ready";
        return runtime;
      })
      .catch((err) => {
        this.status = "error";
        // Clear the cached promise, or a transient network failure would
        // poison the kernel for the rest of the session.
        this.loading = null;
        throw err;
      });

    return this.loading;
  }

  /** Route interpreter output into the running cell, if there is one. */
  private attachSinks(runtime: PyodideLike): void {
    runtime.setStdout({
      batched: (text) => {
        this.current?.stdout.push(text);
      },
    });
    runtime.setStderr({
      batched: (text) => {
        this.current?.stderr.push(text);
      },
    });
  }

  /**
   * Run a cell.
   *
   * Serialised deliberately: Python is single-threaded, and interleaving two
   * cells would produce output attributed to the wrong one.
   */
  async run(code: string): Promise<CellOutput> {
    const runtime = await this.load();

    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const previous = this.queue;
    this.queue = previous.then(() => turn);

    await previous;

    this.status = "running";
    this.current = { stdout: [], stderr: [] };

    try {
      if (this.options.autoLoadPackages && runtime.loadPackagesFromImports) {
        await runtime.loadPackagesFromImports(code);
      }
      const result = await runtime.runPythonAsync(code);
      return {
        stdout: this.current.stdout.join(""),
        stderr: this.current.stderr.join(""),
        result: normalise(result),
      };
    } catch (err) {
      return {
        stdout: this.current.stdout.join(""),
        stderr: this.current.stderr.join(""),
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.current = null;
      this.status = this.status === "error" ? "error" : "ready";
      release();
    }
  }

  /** Reset interpreter state, for an explicit user-initiated restart. */
  async restart(): Promise<void> {
    this.pyodide = null;
    this.loading = null;
    this.queue = Promise.resolve();
    this.current = null;
    this.status = "idle";
  }
}

/**
 * Make a Python value safe to hand to the UI.
 *
 * Pyodide returns proxies for user-defined objects, which cannot be
 * structured-cloned into the page. Rather than throw, describe what it is —
 * the same principle as the server-side serialiser.
 */
export function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "function") return `[function ${(value as Function).name || "anonymous"}]`;
  if (t === "bigint") return `${value as bigint}n`;
  if (t !== "object") return value;

  if (Array.isArray(value)) return value.slice(0, 1000).map(normalise);

  // A Pyodide proxy carries a `type` naming the Python class.
  const asAny = value as { type?: unknown; toString?: () => string };
  if (typeof asAny.type === "string" && asAny.type !== "dict" && asAny.type !== "list") {
    try {
      return `${asAny.type}(${String(value)})`;
    } catch {
      return `[${asAny.type}]`;
    }
  }

  return value;
}
