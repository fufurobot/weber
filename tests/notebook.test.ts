/**
 * Reactive notebook engine.
 *
 * Weber's Script Mode is reactive the way Observable/Marimo are: cells form a
 * dependency graph, and editing one cell re-runs exactly its transitive
 * dependents — in topological order, without re-running independent cells.
 *
 * The graph is derived from code, not declared by hand: a cell's exported
 * bindings are its outputs, and free identifiers that match another cell's
 * exports become edges.
 */
import { describe, expect, test } from "bun:test";
import { NotebookEngine } from "../src/core/notebook/engine";
import { parseCell } from "../src/core/notebook/parse";

describe("parseCell", () => {
  test("collects top-level bindings as outputs", () => {
    expect(parseCell("const a = 1;\nlet b = 2;\nvar c = 3;").defines).toEqual(["a", "b", "c"]);
  });

  test("collects function and class declarations", () => {
    expect(parseCell("function f() {}\nclass C {}").defines).toEqual(["f", "C"]);
  });

  test("collects arrow-function bindings", () => {
    expect(parseCell("const add = (x, y) => x + y;").defines).toEqual(["add"]);
  });

  test("collects destructured bindings", () => {
    expect(parseCell("const { p, q } = obj;").defines).toEqual(["p", "q"]);
  });

  test("ignores bindings nested inside functions", () => {
    expect(parseCell("function f() { const hidden = 1; }").defines).toEqual(["f"]);
  });

  test("collects free identifiers as references", () => {
    const cell = parseCell("const sum = a + b;");
    expect(cell.references).toContain("a");
    expect(cell.references).toContain("b");
  });

  test("does not report a cell's own bindings as references", () => {
    expect(parseCell("const a = 1; const b = a + 1;").references).not.toContain("a");
  });

  test("ignores property accesses and object keys", () => {
    const cell = parseCell("const x = obj.field + other['k'];");
    expect(cell.references).not.toContain("field");
    expect(cell.references).not.toContain("obj");
  });

  test("ignores language keywords and literals", () => {
    const cell = parseCell("const x = typeof undefined;");
    expect(cell.references).not.toContain("typeof");
    expect(cell.references).not.toContain("undefined");
  });

  test("treats a markdown cell as having neither definitions nor references", () => {
    const cell = parseCell("# Title", "markdown");
    expect(cell.defines).toEqual([]);
    expect(cell.references).toEqual([]);
  });
});

describe("NotebookEngine.run", () => {
  test("runs independent cells and exposes their exports", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 1;" },
      { id: "b", code: "const b = 2;" },
    ]);
    const r = await nb.run();
    expect(r.status).toBe("ok");
    expect(nb.values.get("a")).toBe(1);
    expect(nb.values.get("b")).toBe(2);
  });

  test("propagates values along a dependency chain", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 2;" },
      { id: "b", code: "const b = a * 3;" },
      { id: "c", code: "const c = b + 1;" },
    ]);
    await nb.run();
    expect(nb.values.get("c")).toBe(7);
  });

  test("orders execution topologically regardless of cell order", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "c", code: "const c = b + 1;" },
      { id: "b", code: "const b = a * 3;" },
      { id: "a", code: "const a = 2;" },
    ]);
    const r = await nb.run();
    expect(r.status).toBe("ok");
    expect(nb.values.get("c")).toBe(7);
  });

  test("re-running after an edit recomputes only affected cells", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 1;" },
      { id: "b", code: "const b = a + 1;" },
      { id: "untouched", code: "const untouched = 100;" },
    ]);
    await nb.run();
    const first = nb.runCount("untouched");

    nb.setCell("a", "const a = 10;");
    const r = await nb.run();

    expect(nb.values.get("b")).toBe(11);
    expect(nb.runCount("untouched")).toBe(first);
    expect(r.executed).toContain("a");
    expect(r.executed).toContain("b");
    expect(r.executed).not.toContain("untouched");
  });

  test("reports a cell error without discarding other results", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "good", code: "const good = 'fine';" },
      { id: "bad", code: "throw new Error('boom');" },
    ]);
    const r = await nb.run();
    expect(r.status).toBe("error");
    expect(nb.values.get("good")).toBe("fine");
    expect(r.errors.get("bad")).toMatch(/boom/);
  });

  test("skips dependents of a failed cell and marks them stale", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 1;" },
      { id: "b", code: "const b = a + missing;" },
      { id: "c", code: "const c = b + 1;" },
    ]);
    const r = await nb.run();
    expect(nb.runCount("c")).toBe(0);
    expect(r.skipped).toContain("c");
  });

  test("detects a dependency cycle instead of looping forever", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "x", code: "const x = y + 1;" },
      { id: "y", code: "const y = x + 1;" },
    ]);
    const r = await nb.run();
    expect(r.status).toBe("error");
    expect([...r.errors.values()].join(" ")).toMatch(/cycle/i);
    expect(r.executed).toEqual([]);
  });

  test("exposes outputs through an explicit export object", async () => {
    const nb = new NotebookEngine();
    nb.setCells([{ id: "a", code: "const a = 41; const out = a + 1;" }]);
    await nb.run();
    expect(nb.values.get("a")).toBe(41);
    expect(nb.values.get("out")).toBe(42);
  });

  test("ignores markdown cells when executing", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "md", code: "# Heading", kind: "markdown" },
      { id: "a", code: "const a = 5;" },
    ]);
    const r = await nb.run();
    expect(r.status).toBe("ok");
    expect(nb.values.get("a")).toBe(5);
  });

  test("deleting a cell removes its bindings from the graph", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 1;" },
      { id: "b", code: "const b = a + 1;" },
    ]);
    await nb.run();

    nb.setCells([{ id: "b", code: "const b = 5;" }]);
    const r = await nb.run();
    expect(r.status).toBe("ok");
    expect(nb.values.get("b")).toBe(5);
  });

  test("emits an execution trace naming each cell in order", async () => {
    const nb = new NotebookEngine();
    nb.setCells([
      { id: "a", code: "const a = 1;" },
      { id: "b", code: "const b = a + 1;" },
    ]);
    const r = await nb.run();
    expect(r.executed.indexOf("a")).toBeLessThan(r.executed.indexOf("b"));
  });
});
