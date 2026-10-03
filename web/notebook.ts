/**
 * Script Mode — the reactive notebook view.
 *
 * The reactivity lives in the server (`src/core/notebook/engine.ts`); this
 * module owns the editing surface and shows what the engine decided, so a user
 * can see *why* a cell re-ran rather than guessing.
 */
import { api, type NotebookCellPayload, type NotebookResult } from "./api";

export interface Cell {
  id: string;
  code: string;
  kind: "code" | "markdown";
}

/** Stable, readable cell ids so run traces are legible. */
function nextId(existing: Cell[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(`cell-${n}`)) n++;
  return `cell-${n}`;
}

export class NotebookView {
  private cells: Cell[] = [
    { id: "cell-1", code: "const greeting = 'hello weber';", kind: "code" },
    { id: "cell-2", code: "const shout = greeting.toUpperCase() + '!';", kind: "code" },
  ];
  private result: NotebookResult | null = null;
  private running = false;

  constructor(private readonly mount: HTMLElement) {
    this.render();
  }

  /** Serialize for the API, skipping markdown (documentation, not code). */
  private payload(): NotebookCellPayload[] {
    return this.cells.map((c) => ({ id: c.id, code: c.code, kind: c.kind }));
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.render();
    try {
      this.result = await api.notebook(this.payload());
    } catch (err) {
      this.result = {
        status: "error",
        executed: [],
        skipped: [],
        errors: { _: err instanceof Error ? err.message : String(err) },
        values: {},
      };
    } finally {
      this.running = false;
      this.render();
    }
  }

  addCell(kind: "code" | "markdown" = "code"): void {
    this.cells.push({ id: nextId(this.cells), code: "", kind });
    this.render();
  }

  removeCell(id: string): void {
    this.cells = this.cells.filter((c) => c.id !== id);
    this.render();
  }

  setCode(id: string, code: string): void {
    const cell = this.cells.find((c) => c.id === id);
    if (cell) cell.code = code;
  }

  getCells(): Cell[] {
    return this.cells.map((c) => ({ ...c }));
  }

  private render(): void {
    this.mount.innerHTML = "";

    const bar = el("div", "nb-bar");
    bar.append(
      button("Run notebook", () => void this.run(), this.running ? "busy" : "primary"),
      button("Add cell", () => this.addCell("code")),
      button("Add markdown", () => this.addCell("markdown")),
    );
    if (this.result) {
      const status = el("span", `nb-status ${this.result.status}`);
      status.textContent =
        this.result.status === "ok"
          ? `ok — ran ${this.result.executed.length} cell(s)`
          : `error — ${Object.keys(this.result.errors).length} cell(s) failed`;
      bar.append(status);
    }
    this.mount.append(bar);

    for (const cell of this.cells) {
      this.mount.append(this.renderCell(cell));
    }

    if (this.result && Object.keys(this.result.values).length > 0) {
      const out = el("div", "nb-values");
      out.append(el("h3", "", "Bindings"));
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(this.result.values, null, 2);
      out.append(pre);
      this.mount.append(out);
    }
  }

  private renderCell(cell: Cell): HTMLElement {
    const wrap = el("div", `nb-cell ${cell.kind}`);

    const head = el("div", "nb-cell-head");
    const id = el("span", "nb-cell-id", cell.id);
    head.append(id);

    // Show what the engine did with this cell, so reactivity is observable.
    if (this.result) {
      if (this.result.executed.includes(cell.id)) head.append(el("span", "tag ran", "ran"));
      else if (this.result.skipped.includes(cell.id)) head.append(el("span", "tag skip", "skipped"));
      else if (this.result.errors[cell.id]) head.append(el("span", "tag err", "failed"));
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
    // Ctrl/Cmd+Enter runs the notebook, matching notebook conventions.
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
    });
    wrap.append(ta);

    const err = this.result?.errors[cell.id];
    if (err) {
      const e = el("div", "nb-error");
      e.textContent = err;
      wrap.append(e);
    }
    return wrap;
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
