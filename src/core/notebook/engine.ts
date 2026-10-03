/**
 * Reactive notebook engine.
 *
 * Cells form a directed graph derived from their source: editing a cell
 * re-runs exactly its transitive dependents, in topological order, and leaves
 * independent cells untouched. That is what makes Script Mode feel reactive
 * rather than merely re-evaluative.
 */
import { parseCell, type CellKind } from "./parse";

export interface Cell {
  id: string;
  code: string;
  kind?: CellKind;
}

export type RunStatus = "ok" | "error";

export interface RunResult {
  status: RunStatus;
  /** Cells actually executed, in execution order. */
  executed: string[];
  /** Cells not executed because an upstream cell failed. */
  skipped: string[];
  errors: Map<string, string>;
}

/** A cell's code receives the values of its dependencies as a bound scope. */
type CellFunction = (...args: unknown[]) => unknown;

/** Must match the parameter list the engine generates in `compile`. */
const EXPORT_MARKER = "__weber_exports__";

export class NotebookEngine {
  private cells: Cell[] = [];
  /** Binding name -> owning cell id. */
  private owners = new Map<string, string>();
  /** cell id -> its dependencies (cells it reads from). */
  private deps = new Map<string, Set<string>>();
  /** cell id -> cells that depend on it. */
  private dependents = new Map<string, Set<string>>();
  /** Execution counters, exposed for tests and telemetry. */
  private runs = new Map<string, number>();
  /** Cells whose source changed since their last successful execution. */
  private dirty = new Set<string>();

  /** Mark a cell and every transitive dependent as needing re-execution. */
  private markDirty(id: string): void {
    if (this.dirty.has(id)) return;
    this.dirty.add(id);
    for (const dependent of this.dependents.get(id) ?? []) this.markDirty(dependent);
  }

  /**
   * Values exported by the most recent successful run.
   *
   * Keyed by binding name (so `const c = b + 1` publishes `c`), because a
   * notebook's unit of meaning is the name a reader would type, not the cell.
   */
  readonly values = new Map<string, unknown>();

  setCells(cells: Cell[]): void {
    const previous = new Map(this.cells.map((c) => [c.id, c.code]));
    this.cells = cells.map((c) => ({ ...c, kind: c.kind ?? "code" }));
    // Cells whose source changed (or that are brand new) must re-run.
    for (const cell of this.cells) {
      if (previous.get(cell.id) !== cell.code) this.markDirty(cell.id);
    }
    this.rebuild();
  }

  setCell(id: string, code: string): void {
    const existing = this.cells.find((c) => c.id === id);
    if (existing) {
      if (existing.code !== code) this.markDirty(id);
      existing.code = code;
    } else {
      this.cells.push({ id, code, kind: "code" });
      this.markDirty(id);
    }
    this.rebuild();
  }

  removeCell(id: string): void {
    this.cells = this.cells.filter((c) => c.id !== id);
    // Anything that read from this cell is now potentially broken.
    for (const dependent of this.dependents.get(id) ?? []) this.markDirty(dependent);
    this.retract(id);
    this.dirty.delete(id);
    this.rebuild();
  }

  getCells(): Cell[] {
    return this.cells.map((c) => ({ ...c }));
  }

  runCount(id: string): number {
    return this.runs.get(id) ?? 0;
  }

  /** Recompute which cell owns each binding and derive edges between cells. */
  private rebuild(): void {
    this.owners.clear();
    this.deps.clear();
    this.dependents.clear();

    const parsed = new Map<string, ReturnType<typeof parseCell>>();
    for (const cell of this.cells) {
      const p = parseCell(cell.code, cell.kind ?? "code");
      parsed.set(cell.id, p);
      // Later cells win a contested name; that matches how a reader would
      // expect the most recently written cell to take effect.
      for (const name of p.defines) this.owners.set(name, cell.id);
    }

    for (const cell of this.cells) {
      const p = parsed.get(cell.id)!;
      const set = new Set<string>();
      for (const ref of p.references) {
        const owner = this.owners.get(ref);
        if (owner && owner !== cell.id) set.add(owner);
      }
      this.deps.set(cell.id, set);
      this.dependents.set(cell.id, this.dependents.get(cell.id) ?? new Set());
    }
    for (const [cellId, set] of this.deps) {
      for (const dep of set) {
        const list = this.dependents.get(dep) ?? new Set<string>();
        list.add(cellId);
        this.dependents.set(dep, list);
      }
    }
  }

  /** Topological order over the dependency graph. Throws on a cycle. */
  private topoOrder(): string[] {
    const order: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (id: string): void => {
      const s = state.get(id);
      if (s === "done") return;
      if (s === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
        throw new Error(`dependency cycle detected: ${cycle}`);
      }
      state.set(id, "visiting");
      stack.push(id);
      for (const dep of this.sorted(this.deps.get(id) ?? new Set())) visit(dep);
      stack.pop();
      state.set(id, "done");
      order.push(id);
    };

    for (const cell of this.cells) visit(cell.id);
    return order;
  }

  /** Deterministic iteration: cell declaration order, not Set insertion order. */
  private sorted(ids: Iterable<string>): string[] {
    const index = new Map(this.cells.map((c, i) => [c.id, i]));
    return [...ids].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
  }

  /**
   * Execute the notebook.
   *
   * Only cells whose source changed since their last run, plus their
   * transitive dependents, are re-executed — that is what makes Script Mode
   * reactive rather than merely re-evaluative. Pass `only` to force a subset.
   *
   * Cells run in topological order. A failing cell causes its transitive
   * dependents to be skipped rather than executed with stale or missing
   * bindings, and the failure is reported per cell.
   */
  async run(only?: Iterable<string>): Promise<RunResult> {
    const result: RunResult = {
      status: "ok",
      executed: [],
      skipped: [],
      errors: new Map(),
    };

    let order: string[];
    try {
      order = this.topoOrder();
    } catch (err) {
      // A cycle means nothing can be evaluated meaningfully; report and stop.
      result.status = "error";
      const message = err instanceof Error ? err.message : String(err);
      for (const cell of this.cells) result.errors.set(cell.id, message);
      return result;
    }

    // A forced run targets the given cells plus everything downstream.
    const target = only === undefined ? null : new Set([...only, ...this.dependentsOf(only)]);

    for (const id of order) {
      const cell = this.cells.find((c) => c.id === id)!;
      if ((cell.kind ?? "code") === "markdown") continue; // documentation only
      if (target && !target.has(id)) continue;
      // Skip cells that are already up to date.
      if (!target && !this.dirty.has(id) && this.runs.has(id)) continue;

      // Any failed dependency taints this cell.
      const failedDep = this.sorted(this.deps.get(id) ?? new Set()).find((d) =>
        result.errors.has(d),
      );
      if (failedDep) {
        result.skipped.push(id);
        continue;
      }

      try {
        const exported = await this.execute(cell);
        this.publish(cell.id, exported);
        this.runs.set(id, this.runCount(id) + 1);
        this.dirty.delete(id);
        result.executed.push(id);
      } catch (err) {
        result.status = "error";
        result.errors.set(id, err instanceof Error ? err.message : String(err));
        this.dirty.add(id);
        this.retract(cell.id);
      }
    }

    return result;
  }

  /** Transitive closure of `ids` over the dependents relation. */
  private dependentsOf(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue = [...ids];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const next of this.dependents.get(id) ?? []) {
        if (out.has(next)) continue;
        out.add(next);
        queue.push(next);
      }
    }
    return out;
  }

  /**
   * Evaluate one cell and return its exported bindings.
   *
   * Dependencies are injected as named parameters so a cell reads them as
   * plain identifiers, which is what makes cells look like notebook code
   * rather than an explicit wiring DSL.
   */
  private async execute(cell: Cell): Promise<Record<string, unknown>> {
    const deps = this.sorted(this.deps.get(cell.id) ?? new Set());
    const parsed = parseCell(cell.code, cell.kind ?? "code");

    // Inject exactly the dependency bindings this cell references, so a cell
    // cannot observe names it never mentioned.
    const paramNames: string[] = [];
    const paramValues: unknown[] = [];
    for (const dep of deps) {
      for (const name of this.bindingsOf(dep)) {
        if (!parsed.references.includes(name)) continue;
        if (paramNames.includes(name)) continue;
        paramNames.push(name);
        paramValues.push(this.values.get(name));
      }
    }

    // Publish the cell's own bindings by name, plus an explicit marker object
    // if the cell opted into one for computed exports.
    const body = [
      cell.code,
      `;return (typeof ${EXPORT_MARKER} !== "undefined" && ${EXPORT_MARKER}) ? Object.assign({${parsed.defines
        .map((n) => `${JSON.stringify(n)}: ${n}`)
        .join(",")}}, ${EXPORT_MARKER}) : {${parsed.defines
        .map((n) => `${JSON.stringify(n)}: ${n}`)
        .join(",")}};`,
    ].join("\n");

    let fn: CellFunction;
    try {
      // Cells are authored by the user in their own workspace; evaluating them
      // is the product, and isolation is a deployment concern (WEBER_SANDBOX).
      // eslint-disable-next-line no-new-func
      fn = new Function(...paramNames, body) as CellFunction;
    } catch (err) {
      throw new Error(
        `failed to compile cell: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const out = await fn(...paramValues);
    if (out === null || typeof out !== "object") {
      throw new Error("cell did not produce an export object");
    }
    return out as Record<string, unknown>;
  }

  /** Binding names a cell publishes. */
  private bindingsOf(cellId: string): string[] {
    const cell = this.cells.find((c) => c.id === cellId);
    if (!cell) return [];
    return parseCell(cell.code, cell.kind ?? "code").defines;
  }

  /** Remove a cell's stale bindings after a failed run. */
  private retract(cellId: string): void {
    for (const name of this.bindingsOf(cellId)) this.values.delete(name);
  }

  /** Publish a cell's exported bindings, and drop names it no longer defines. */
  private publish(cellId: string, exported: Record<string, unknown>): void {
    const expected = new Set(this.bindingsOf(cellId));
    for (const name of this.bindingsOf(cellId)) {
      this.values.set(name, exported[name]);
    }
    // A cell that previously defined a name it no longer defines must not leave
    // the stale value reachable through the graph.
    for (const [name, owner] of this.owners) {
      if (owner === cellId && !expected.has(name)) this.values.delete(name);
    }
  }
}
