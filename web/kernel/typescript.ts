/**
 * TypeScript notebook kernel.
 *
 * Weber already has a *reactive* TypeScript engine that runs server-side
 * (`src/core/notebook/engine.ts`). This is a different thing: a linear,
 * in-browser JS kernel for Pages-only use, where there is no server at all.
 *
 * The two are not interchangeable and the UI must not pretend otherwise:
 *
 *   - the server engine derives a dependency graph and re-runs dependents
 *   - this kernel runs cells in order and shares a scope
 *
 * Sharing a scope is what makes it useful (cell 2 sees cell 1's `const`), and
 * also what makes it non-reactive: editing cell 1 does not re-run cell 2.
 * Saying so in the UI is cheaper than a bug report explaining it.
 */

export type KernelLanguage = "typescript" | "python" | "markdown";

export interface CellResult {
  /** Anything the cell logged. */
  output: string[];
  /** The final expression's value, when there is one. */
  result?: unknown;
  error?: string;
}

/**
 * Cells share one lexical scope.
 *
 * Implemented by accumulating declarations and re-evaluating the whole
 * program, rather than by evaluating each cell separately: separate evaluation
 * cannot see a previous cell's `const`, which is the thing that makes a
 * notebook a notebook.
 */
export class TypeScriptKernel {
  private readonly cells: { id: string; code: string }[] = [];
  private outputs: string[] = [];

  /** Register or replace a cell, preserving order. */
  setCell(id: string, code: string): void {
    const existing = this.cells.findIndex((c) => c.id === id);
    if (existing >= 0) this.cells[existing]!.code = code;
    else this.cells.push({ id, code });
  }

  removeCell(id: string): void {
    const i = this.cells.findIndex((c) => c.id === id);
    if (i >= 0) this.cells.splice(i, 1);
  }

  getCells(): { id: string; code: string }[] {
    return this.cells.map((c) => ({ ...c }));
  }

  /**
   * Run every cell in order and return the result of the last one.
   *
   * `translate` is injected so the browser can use a real transpiler
   * (esbuild-wasm/SWC) while tests stay hermetic and dependency-free.
   */
  async runAll(
    translate: (code: string) => Promise<string> | string = identity,
  ): Promise<CellResult> {
    const output: string[] = [];
    this.outputs = output;

    // Cells are concatenated into one program so they share a scope. Later
    // declarations of the same name are a redeclaration error in JS, so a
    // duplicate is reported rather than silently shadowing.
    const seen = new Map<string, string>();
    for (const cell of this.cells) {
      for (const name of declaredNames(cell.code)) {
        const previous = seen.get(name);
        if (previous !== undefined && previous !== cell.id) {
          return {
            output,
            error:
              `"${name}" is declared in both ${previous} and ${cell.id}. ` +
              `Cells share one scope, so rename one of them.`,
          };
        }
        seen.set(name, cell.id);
      }
    }

    const body = this.cells.map((c) => c.code).join("\n");
    const lastCell = this.cells[this.cells.length - 1];

    try {
      const js = await translate(body);
      // Indirect eval runs in global scope, matching a browser notebook.
      const runner = new Function(
        "log",
        `"use strict";\n${js}\nreturn ${lastValueExpression(lastCell?.code ?? "")}`,
      );
      const result = runner((...args: unknown[]) => {
        output.push(args.map(format).join(" "));
      });
      return { output, result: safeValue(result) };
    } catch (err) {
      return { output, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Clear all cells and captured output. */
  reset(): void {
    this.cells.length = 0;
    this.outputs = [];
  }
}

function identity(code: string): string {
  return code;
}

/**
 * Names declared at the top level of a cell.
 *
 * Approximate on purpose: this exists to produce a *helpful error* for a
 * duplicate declaration, not to enforce correctness. A miss costs a worse
 * message, never a wrong result.
 *
 * Scanned across the whole cell rather than per line, because
 * `const a = 1; let b;` on one line declares two names.
 */
export function declaredNames(code: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|[;{}\n]|\bexport\s+)\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(pattern)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

/**
 * The expression whose value a cell should return, if the last line is one.
 *
 * Statements have no value, and wrapping one in parentheses is a syntax error
 * that would surface as a confusing parse failure rather than "nothing to
 * show".
 */
function lastValueExpression(code: string): string {
  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
  const last = lines[lines.length - 1] ?? "";
  // Statements: declarations, control flow, and anything that is not an
  // expression. `throw new Error()` is the one that bit us in testing.
  if (
    /^(const|let|var|function|class|if|for|while|switch|try|throw|return|import|export|break|continue|debugger)\b/.test(
      last,
    )
  ) {
    return "undefined";
  }
  // A trailing opener means the cell is an incomplete block.
  if (/[{([]$/.test(last)) return "undefined";
  if (last.endsWith(";")) return `(${last.slice(0, -1)})`;
  return `(${last})`;
}

/** Make a value safe to render. */
function safeValue(value: unknown): unknown {
  if (value === undefined || value === null) return value ?? null;
  const t = typeof value;
  if (t === "function") return `[function ${(value as Function).name || "anonymous"}]`;
  if (t === "symbol") return "[symbol]";
  if (t === "bigint") return `${value as bigint}n`;
  if (t !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 1000);
  try {
    // Proves serialisability without copying; throws on cycles and proxies.
    JSON.stringify(value);
    return value;
  } catch {
    return String(value);
  }
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
