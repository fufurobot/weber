/**
 * Browser notebook view.
 *
 * Runs against a minimal DOM stub, so it stays hermetic: no browser, no
 * Pyodide download. What it pins is the wiring between the view and the two
 * kernels — the part most likely to be wrong in a way that produces a blank
 * screen rather than an error.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { BrowserNotebook } from "../web/notebook-browser";

/** The smallest DOM this view needs. */
function stubDom() {
  const created: any[] = [];

  function makeElement(tag: string): any {
    const el: any = {
      tagName: tag.toUpperCase(),
      children: [] as any[],
      className: "",
      textContent: "",
      value: "",
      rows: 0,
      spellcheck: true,
      selected: false,
      style: {},
      _listeners: {} as Record<string, ((e: any) => void)[]>,
      append(...nodes: any[]) {
        el.children.push(...nodes);
      },
      addEventListener(type: string, fn: (e: any) => void) {
        (el._listeners[type] ??= []).push(fn);
      },
      setAttribute(name: string, value: string) {
        el[name] = value;
      },
      fire(type: string, event: any = {}) {
        for (const fn of el._listeners[type] ?? []) fn(event);
      },
    };
    created.push(el);
    return el;
  }

  (globalThis as any).document = {
    createElement: makeElement,
  };

  return { mount: makeElement("div"), created };
}

let dom: ReturnType<typeof stubDom>;

beforeEach(() => {
  dom = stubDom();
});

/** A fake Pyodide that emits output during the run, as the real one does. */
function fakeLoader(output = "from python") {
  let stdout: (text: string) => void = () => {};
  return async () => ({
    async runPythonAsync(code: string) {
      if (code.includes("raise")) throw new Error("ValueError: boom");
      // Emitted here, not at registration: a real runtime writes stdout while
      // the cell runs, and a fixture that writes earlier would hide bugs in
      // output attribution.
      if (output) stdout(output);
      return code.length;
    },
    setStdout({ batched }: any) {
      stdout = batched;
    },
    setStderr() {},
  });
}

/** Flatten all text in a stub element tree. */
function allText(node: any): string {
  if (typeof node === "string") return node;
  const own = typeof node?.textContent === "string" ? node.textContent : "";
  const kids = (node?.children ?? []).map(allText).join(" ");
  return `${own} ${kids}`;
}

describe("initial render", () => {
  test("renders the starter cells", () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    expect(nb.getCells().map((c) => c.kind)).toEqual(["markdown", "typescript", "python"]);
  });

  test("states that Python runs locally, since Pages has no server", () => {
    new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    expect(allText(dom.mount)).toMatch(/Pyodide/);
  });

  test("states the cross-kernel scope limitation up front", () => {
    // Otherwise a user tries to use a Python value from TypeScript and files
    // a bug about it.
    new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    expect(allText(dom.mount)).toMatch(/not across languages/i);
  });

  test("does not construct Pyodide eagerly", () => {
    // The whole point of the lazy kernel: rendering must not download 6 MB.
    let loaded = false;
    new BrowserNotebook(dom.mount, {
      loadPyodide: async () => {
        loaded = true;
        return fakeLoader()();
      },
    });
    expect(loaded).toBe(false);
  });
});

describe("cell management", () => {
  test("adds a cell of the requested kind", () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    nb.addCell("python");
    expect(nb.getCells().map((c) => c.kind)).toContain("python");
  });

  test("removes a cell", () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    const before = nb.getCells().length;
    nb.removeCell(nb.getCells()[0]!.id);
    expect(nb.getCells().length).toBe(before - 1);
  });

  test("editing code is reflected in the cells", () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    nb.setCode("cell-2", "const x = 99;\nx");
    expect(nb.getCells().find((c) => c.id === "cell-2")!.code).toContain("99");
  });

  test("changing kind moves the cell between kernels", async () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    nb.setKind("cell-2", "python");
    expect(nb.getCells().find((c) => c.id === "cell-2")!.kind).toBe("python");
  });
});

describe("running", () => {
  test("a TypeScript result is attached to the last TS cell", async () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    nb.setCode("cell-2", "const a = 6;\na * 7");
    await nb.runAll();
    const ts = nb.getCells().filter((c) => c.kind === "typescript");
    expect(ts[ts.length - 1]!.result).toBe(42);
  });

  test("a Python cell captures stdout and its result", async () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader("hello") });
    await nb.runAll();
    const py = nb.getCells().find((c) => c.kind === "python")!;
    expect(py.output?.join("")).toContain("hello");
    expect(py.error).toBeUndefined();
  });

  test("a Python error is reported on that cell", async () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    nb.setCode("cell-3", "raise Exception('boom')");
    await nb.runAll();
    expect(nb.getCells().find((c) => c.id === "cell-3")!.error).toMatch(/boom/);
  });

  test("concurrent runAll calls do not double-run", async () => {
    // Ctrl+Enter twice would otherwise interleave two runs into one output.
    let runs = 0;
    const nb = new BrowserNotebook(dom.mount, {
      loadPyodide: async () => ({
        async runPythonAsync() {
          runs++;
          await new Promise((r) => setTimeout(r, 10));
          return undefined;
        },
        setStdout() {},
        setStderr() {},
      }),
    });
    await Promise.all([nb.runAll(), nb.runAll()]);
    expect(runs).toBe(1);
  });

  test("markdown cells are never executed", async () => {
    let ran = false;
    const nb = new BrowserNotebook(dom.mount, {
      loadPyodide: async () => ({
        async runPythonAsync(code: string) {
          if (code.includes("#")) ran = true;
          return undefined;
        },
        setStdout() {},
        setStderr() {},
      }),
    });
    await nb.runAll();
    expect(ran).toBe(false);
  });

  test("records a duration so slowness is visible", async () => {
    const nb = new BrowserNotebook(dom.mount, { loadPyodide: fakeLoader() });
    await nb.runAll();
    const py = nb.getCells().find((c) => c.kind === "python")!;
    expect(typeof py.durationMs).toBe("number");
  });
});
