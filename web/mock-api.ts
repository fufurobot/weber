/**
 * Mock backend for the static GitHub Pages demo.
 *
 * Implements the same surface as `api.ts`, against in-memory fixtures, so the
 * deployed demo exercises the real UI components rather than a parallel fork.
 *
 * It deliberately keeps a plausible delay and returns realistic shapes: a mock
 * that always succeeds instantly hides loading and error states, which are
 * exactly the things a UI review needs to see.
 */

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
}

export interface Toolchain {
  id: string;
  label: string;
  command: string[];
  binaries: string[];
  available: boolean;
  version?: string;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** In-memory filesystem, seeded with a small believable project. */
const files = new Map<string, string>([
  [
    "README.md",
    [
      "# Demo project",
      "",
      "This file lives in your browser. The Weber backend is not running,",
      "so every edit here is discarded when you reload the page.",
      "",
      "Switch to Script Mode to see the reactive notebook.",
    ].join("\n"),
  ],
  ["package.json", '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n'],
  ["src/index.ts", "export const greet = (name: string) => `hello ${name}`;\n"],
  ["src/util.ts", "export const double = (n: number) => n * 2;\n"],
  ["src/main.rs", 'fn main() {\n    println!("hello from Rust");\n}\n'],
  ["notebook.ts", "const x = 1;\n"],
]);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function now() {
  return Date.now();
}

function childrenOf(dir: string): DirEntry[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const seen = new Set<string>();
  const out: DirEntry[] = [];

  for (const [path, contents] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "") continue;

    const segment = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
    const childPath = `${prefix}${segment}`;
    if (seen.has(childPath)) continue;
    seen.add(childPath);

    const isDir = rest.includes("/");
    out.push({
      name: segment,
      path: childPath,
      kind: isDir ? "directory" : "file",
      size: isDir ? 0 : (contents?.length ?? 0),
      mtime: now(),
    });
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export const api = {
  async health() {
    await delay(120);
    return {
      status: "ok",
      workspaceRoot: "/demo (static demo — no backend)",
      version: "0.1.0-demo",
    };
  },

  async list(path: string): Promise<DirEntry[]> {
    await delay(90);
    // A directory only exists if something lives under it.
    if (path !== "" && ![...files.keys()].some((p) => p.startsWith(`${path}/`))) {
      throw new ApiError(`not found: ${path}`, 404);
    }
    return childrenOf(path);
  },

  async read(path: string) {
    await delay(70);
    const contents = files.get(path);
    if (contents === undefined) throw new ApiError(`not found: ${path}`, 404);
    return { path, contents, size: contents.length, mtime: now() };
  },

  async write(path: string, contents: string) {
    await delay(110);
    files.set(path, contents);
    return { ok: true as const };
  },

  async mkdir(path: string) {
    await delay(80);
    // Represent an empty directory with a placeholder so it survives listing.
    files.set(`${path}/.gitkeep`, "");
    return { ok: true as const };
  },

  async remove(path: string) {
    await delay(110);
    let removed = false;
    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        files.delete(key);
        removed = true;
      }
    }
    if (!removed) throw new ApiError(`not found: ${path}`, 404);
    return { ok: true as const };
  },

  async rename(from: string, to: string) {
    await delay(110);
    const contents = files.get(from);
    if (contents === undefined) throw new ApiError(`not found: ${from}`, 404);
    files.delete(from);
    files.set(to, contents);
    return { ok: true as const };
  },

  async search(q: string): Promise<string[]> {
    await delay(130);
    const needle = q.toLowerCase();
    return [...files.keys()].filter((p) => p.toLowerCase().includes(needle)).sort();
  },

  async projects(): Promise<string[]> {
    await delay(90);
    return ["demo"];
  },

  async tools(): Promise<Toolchain[]> {
    await delay(200);
    // Reflects a realistic mix, including absence, which the UI must handle.
    return [
      { id: "bun", label: "Bun / TypeScript", command: ["bun"], binaries: ["bun"], available: false, error: "not available in the static demo" },
      { id: "node", label: "Node.js", command: ["node"], binaries: ["node"], available: false, error: "not available in the static demo" },
      { id: "rustc", label: "Rust compiler", command: ["rustc"], binaries: ["rustc"], available: false, error: "not available in the static demo" },
      { id: "cargo", label: "Cargo", command: ["cargo"], binaries: ["cargo"], available: false, error: "not available in the static demo" },
      { id: "clang", label: "Clang C/C++", command: ["clang"], binaries: ["clang"], available: false, error: "not available in the static demo" },
      { id: "clangd", label: "clangd LSP", command: ["clangd"], binaries: ["clangd"], available: false, error: "not available in the static demo" },
      { id: "wasmchain", label: "wasmchain", command: ["wasmchain"], binaries: ["wasmchain"], available: false, error: "not available in the static demo" },
      { id: "python", label: "Python (Pyodide in-browser)", command: ["python"], binaries: ["python"], available: false, error: "not available in the static demo" },
    ];
  },

  async run(argv: string[]) {
    await delay(300);
    // Mirrors the server's shape, including a refusal, so the UI path is real.
    if (argv[0] === "curl") {
      return { code: 126, stdout: "", stderr: `command not allowed: ${argv[0]}`, timedOut: false, durationMs: 1 };
    }
    return {
      code: 126,
      stdout: "",
      stderr:
        "This is the static demo: there is no core service to run " +
        `${argv.join(" ")}. Deploy the compose stack for a working terminal.`,
      timedOut: false,
      durationMs: 300,
    };
  },

  /**
   * The notebook engine is real but server-side, so the demo evaluates cells
   * with a small local evaluator. It reproduces the visible contract
   * (bindings published by name, per-cell errors) rather than the real
   * dependency graph, and the UI labels the demo accordingly.
   */
  async notebook(cells: { id: string; code: string; kind?: string }[]) {
    await delay(400);
    const values: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    const executed: string[] = [];
    const skipped: string[] = [];

    for (const cell of cells) {
      if ((cell.kind ?? "code") === "markdown") continue;
      const names = [...cell.code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(
        (m) => m[1]!,
      );
      if (names.length === 0) continue;
      try {
        const fn = new Function(
          ...Object.keys(values),
          `${cell.code}\n;return {${names.map((n) => `${JSON.stringify(n)}: ${n}`).join(",")}};`,
        );
        const out = fn(...Object.values(values));
        Object.assign(values, out);
        executed.push(cell.id);
      } catch (err) {
        errors[cell.id] = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      status: Object.keys(errors).length > 0 ? ("error" as const) : ("ok" as const),
      executed,
      skipped,
      errors,
      values,
    };
  },
};
