/**
 * Script Mode — the browser notebook.
 *
 * This is the **Pages-only** notebook: every cell runs locally, with no server.
 * It is distinct from the reactive notebook in `web/notebook.ts`, which talks
 * to the server engine and derives a dependency graph.
 *
 * Three cell kinds, two kernels:
 *
 *   typescript  → TypeScriptKernel   (linear, shared scope, not reactive)
 *   python      → PythonKernel       (Pyodide, lazily loaded)
 *   markdown    → rendered, not run
 *
 * The two kernels are independent: a Python cell cannot read a TypeScript
 * binding, or vice versa. That is honest about what each runtime is, and
 * pretending otherwise would need a serialisation boundary that does not
 * exist. The UI states it rather than letting a user discover it.
 */
import { PythonKernel, type CellOutput } from "./kernel/python";
import { TypeScriptKernel, type CellResult } from "./kernel/typescript";
import { loadPyodideFromCdn, pyodideSupport, PYODIDE_VERSION } from "./kernel/pyodide-loader";

export type CellKind = "typescript" | "python" | "markdown";

export interface BrowserCell {
  id: string;
  kind: CellKind;
  code: string;
  output?: string[];
  result?: unknown;
  error?: string;
  /** Wall-clock duration, shown so slowness is visible rather than mysterious. */
  durationMs?: number;
}

const STARTER: BrowserCell[] = [
  {
    id: "cell-1",
    kind: "markdown",
    code: "# Weber notebook\n\nCells run in your browser. Nothing is sent to a server.",
  },
  {
    id: "cell-2",
    kind: "typescript",
    code: "const greeting = 'hello weber';\ngreeting.toUpperCase()",
  },
  {
    id: "cell-3",
    kind: "python",
    code: "import sys\nprint('python', sys.version.split()[0])\nsum(range(10))",
  },
];

export interface BrowserNotebookOptions {
  /** Injected so the Pages build, tests and a self-hosted copy can differ. */
  loadPyodide?: () => Promise<unknown>;
}

export class BrowserNotebook {
  private cells: BrowserCell[] = STARTER.map((c) => ({ ...c }));
  private running = false;
  private readonly tsKernel = new TypeScriptKernel();
  private readonly pyKernel: PythonKernel;

  constructor(
    private readonly mount: HTMLElement,
    options: BrowserNotebookOptions = {},
  ) {
    this.pyKernel = new PythonKernel({
      load: (options.loadPyodide ?? (() => loadPyodideFromCdn())) as () => Promise<any>,
    });
    for (const cell of this.cells) this.syncKernel(cell);
    this.render();
  }

  private syncKernel(cell: BrowserCell): void {
    if (cell.kind === "typescript") this.tsKernel.setCell(cell.id, cell.code);
  }

  private nextId(): string {
    let n = this.cells.length + 1;
    const taken = new Set(this.cells.map((c) => c.id));
    while (taken.has(`cell-${n}`)) n++;
    return `cell-${n}`;
  }

  addCell(kind: CellKind = "typescript"): void {
    const cell: BrowserCell = { id: this.nextId(), kind, code: "" };
    this.cells.push(cell);
    this.syncKernel(cell);
    this.render();
  }

  removeCell(id: string): void {
    this.cells = this.cells.filter((c) => c.id !== id);
    this.tsKernel.removeCell(id);
    this.render();
  }

  setCode(id: string, code: string): void {
    const cell = this.cells.find((c) => c.id === id);
    if (!cell) return;
    cell.code = code;
    this.syncKernel(cell);
  }

  setKind(id: string, kind: CellKind): void {
    const cell = this.cells.find((c) => c.id === id);
    if (!cell) return;
    cell.kind = kind;
    if (kind === "typescript") this.tsKernel.setCell(cell.id, cell.code);
    else this.tsKernel.removeCell(cell.id);
    this.render();
  }

  getCells(): BrowserCell[] {
    return this.cells.map((c) => ({ ...c }));
  }

  /**
   * Run every runnable cell in order.
   *
   * TypeScript runs first because it is instant, while Pyodide's first load
   * takes seconds — running Python first would make the whole notebook feel
   * frozen before the user sees any result at all.
   */
  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.render();

    try {
      const tsCells = this.cells.filter((c) => c.kind === "typescript");
      if (tsCells.length > 0) {
        const started = Date.now();
        const out = await this.tsKernel.runAll();
        this.applyTypeScriptResult(out, Date.now() - started);
      }

      for (const cell of this.cells) {
        if (cell.kind !== "python") continue;
        const started = Date.now();
        const out = await this.pyKernel.run(cell.code);
        this.applyPythonResult(cell, out, Date.now() - started);
      }
    } finally {
      this.running = false;
      this.render();
    }
  }

  /**
   * TypeScript cells share one scope, so a single run covers all of them. The
   * result is attributed to the last cell, which is where the value came from.
   */
  private applyTypeScriptResult(out: CellResult, durationMs: number): void {
    const tsCells = this.cells.filter((c) => c.kind === "typescript");
    for (const cell of tsCells) {
      cell.output = undefined;
      cell.result = undefined;
      cell.error = undefined;
      cell.durationMs = undefined;
    }
    const target = tsCells[tsCells.length - 1];
    if (!target) return;
    target.output = out.output;
    target.result = out.result;
    target.error = out.error;
    target.durationMs = durationMs;
  }

  private applyPythonResult(cell: BrowserCell, out: CellOutput, durationMs: number): void {
    cell.output = [out.stdout, out.stderr].filter((s) => s.length > 0);
    cell.result = out.result;
    cell.error = out.error;
    cell.durationMs = durationMs;
  }

  private render(): void {
    this.mount.innerHTML = "";

    const bar = el("div", "nb-bar");
    bar.append(
      button(
        this.running ? "Running…" : "Run all",
        () => void this.runAll(),
        this.running ? "busy" : "primary",
      ),
      button("+ TypeScript", () => this.addCell("typescript")),
      button("+ Python", () => this.addCell("python")),
      button("+ Markdown", () => this.addCell("markdown")),
    );

    const support = pyodideSupport();
    bar.append(
      el(
        "span",
        "nb-note",
        support.supported
          ? `Python runs locally via Pyodide ${PYODIDE_VERSION} — first run downloads ~6 MB`
          : (support.reason ?? "Python unavailable"),
      ),
    );
    this.mount.append(bar);

    // State the cross-kernel limitation once, rather than letting a user
    // discover it by trying to use a Python value from TypeScript.
    this.mount.append(
      el(
        "div",
        "nb-hint",
        "Each cell kind shares its own scope: TypeScript cells see each other, Python cells see each other, but not across languages.",
      ),
    );

    for (const cell of this.cells) this.mount.append(this.renderCell(cell));
  }

  private renderCell(cell: BrowserCell): HTMLElement {
    const wrap = el("div", `nb-cell ${cell.kind}`);

    const head = el("div", "nb-cell-head");
    head.append(el("span", "nb-cell-id", cell.id));

    const select = document.createElement("select");
    select.className = "nb-kind";
    for (const kind of ["typescript", "python", "markdown"] as const) {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent =
        kind === "typescript" ? "TypeScript" : kind === "python" ? "Python" : "Markdown";
      if (cell.kind === kind) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => this.setKind(cell.id, select.value as CellKind));
    head.append(select);

    if (cell.durationMs !== undefined) {
      head.append(el("span", "nb-duration", `${cell.durationMs} ms`));
    }

    const remove = button("✕", () => this.removeCell(cell.id), "icon");
    remove.setAttribute("aria-label", `remove ${cell.id}`);
    head.append(remove);
    wrap.append(head);

    const ta = document.createElement("textarea");
    ta.className = "nb-input";
    ta.value = cell.code;
    ta.rows = Math.max(2, cell.code.split("\n").length);
    ta.spellcheck = false;
    ta.addEventListener("input", () => this.setCode(cell.id, ta.value));
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.runAll();
      }
    });
    wrap.append(ta);

    if (cell.output && cell.output.length > 0) {
      const out = el("pre", "nb-output");
      out.textContent = cell.output.join("\n");
      wrap.append(out);
    }

    if (cell.result !== undefined && cell.result !== null) {
      wrap.append(el("div", "nb-result", stringify(cell.result)));
    }

    if (cell.error) {
      wrap.append(el("div", "nb-error", cell.error));
    }

    return wrap;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function el(tag: string, className = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}
