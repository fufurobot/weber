/**
 * Pyodide kernel.
 *
 * These run against a fake Pyodide, so they are hermetic: no 6 MB download, no
 * browser. What they pin is the behaviour that would otherwise be a bug report
 * nobody can reproduce — lazy loading, output attribution, and surviving a
 * failed load.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { PythonKernel, normalise, type PyodideLike } from "../web/kernel/python";

/** A fake Pyodide that records calls and lets tests script failures. */
function fakePyodide(overrides: Partial<PyodideLike> = {}) {
  const state = {
    stdout: (text: string) => {},
    stderr: (text: string) => {},
    calls: [] as string[],
    failNext: false,
  };

  const runtime: PyodideLike = {
    async runPythonAsync(code: string) {
      state.calls.push(code);
      if (state.failNext) {
        // One-shot: a fixture that failed forever would make "the kernel still
        // works afterwards" untestable.
        state.failNext = false;
        throw new Error("NameError: name 'x' is not defined");
      }
      return undefined;
    },
    setStdout({ batched }) {
      state.stdout = batched;
    },
    setStderr({ batched }) {
      state.stderr = batched;
    },
    ...overrides,
  };

  return { runtime, state };
}

let loadCount: number;
let fake: ReturnType<typeof fakePyodide>;

beforeEach(() => {
  loadCount = 0;
  fake = fakePyodide();
});

function kernel(options: Partial<Parameters<typeof PythonKernel.prototype.constructor>[0]> = {}) {
  return new PythonKernel({
    load: async () => {
      loadCount++;
      return fake.runtime;
    },
    ...options,
  });
}

describe("lazy loading", () => {
  test("does not load the runtime until a cell runs", () => {
    // A user who only wants TypeScript must never pay 6 MB for Python.
    kernel();
    expect(loadCount).toBe(0);
  });

  test("loads once, on first run", async () => {
    const k = kernel();
    await k.run("1 + 1");
    expect(loadCount).toBe(1);
  });

  test("reuses the loaded runtime across cells", async () => {
    const k = kernel();
    await k.run("1");
    await k.run("2");
    await k.run("3");
    expect(loadCount).toBe(1);
  });

  test("concurrent first runs trigger only one load", async () => {
    // Two cells can both be queued before either finishes loading.
    const k = kernel();
    await Promise.all([k.run("a"), k.run("b"), k.run("c")]);
    expect(loadCount).toBe(1);
  });

  test("reports status transitions", async () => {
    const k = kernel();
    expect(k.getStatus()).toBe("idle");
    const running = k.run("1");
    await running;
    expect(k.getStatus()).toBe("ready");
  });
});

describe("failure handling", () => {
  test("a failed load is retryable, not permanent", async () => {
    // A transient network failure must not poison the kernel for the session.
    let attempts = 0;
    const k = new PythonKernel({
      load: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network down");
        return fake.runtime;
      },
    });

    await expect(k.run("1")).rejects.toThrow("network down");
    expect(k.getStatus()).toBe("error");

    await k.run("1");
    expect(attempts).toBe(2);
    expect(k.getStatus()).toBe("ready");
  });

  test("a cell error is returned, not thrown", async () => {
    // Throwing would lose the partial stdout the user needs to see.
    const k = kernel();
    fake.state.failNext = true;
    const out = await k.run("undefined_name");
    expect(out.error).toMatch(/NameError/);
  });

  test("the kernel stays usable after a cell error", async () => {
    const k = kernel();
    fake.state.failNext = true;
    await k.run("bad");
    const out = await k.run("1 + 1");
    expect(out.error).toBeUndefined();
    expect(k.getStatus()).toBe("ready");
  });
});

describe("output attribution", () => {
  test("captures stdout for the running cell", async () => {
    const k = kernel({
      load: async () => {
        loadCount++;
        return {
          ...fake.runtime,
          async runPythonAsync(code: string) {
            fake.state.stdout("hello from python");
            return undefined;
          },
        };
      },
    });
    const out = await k.run("print('hello')");
    expect(out.stdout).toContain("hello from python");
  });

  test("captures stderr separately from stdout", async () => {
    const k = new PythonKernel({
      load: async () => ({
        ...fake.runtime,
        async runPythonAsync() {
          fake.state.stdout("normal");
          fake.state.stderr("warning");
          return undefined;
        },
      }),
    });
    const out = await k.run("...");
    expect(out.stdout).toContain("normal");
    expect(out.stdout).not.toContain("warning");
    expect(out.stderr).toContain("warning");
  });

  test("cells run in submission order even when they overlap", async () => {
    // Interleaving would attribute output to the wrong cell.
    const order: string[] = [];
    const k = new PythonKernel({
      load: async () => ({
        ...fake.runtime,
        async runPythonAsync(code: string) {
          order.push(`start:${code}`);
          await new Promise((r) => setTimeout(r, code === "a" ? 20 : 1));
          order.push(`end:${code}`);
          return undefined;
        },
      }),
    });

    await Promise.all([k.run("a"), k.run("b")]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("output is not leaked into a later cell", async () => {
    let emit: (t: string) => void = () => {};
    const k = new PythonKernel({
      load: async () => ({
        ...fake.runtime,
        setStdout({ batched }) {
          emit = batched;
        },
        async runPythonAsync(code: string) {
          if (code === "first") emit("one");
          return undefined;
        },
      }),
    });

    const a = await k.run("first");
    const b = await k.run("second");
    expect(a.stdout).toContain("one");
    expect(b.stdout).toBe("");
  });
});

describe("packages", () => {
  test("does not auto-install by default, since it is a network call", async () => {
    let called = false;
    const k = new PythonKernel({
      load: async () => ({
        ...fake.runtime,
        async loadPackagesFromImports() {
          called = true;
        },
      }),
    });
    await k.run("import numpy");
    expect(called).toBe(false);
  });

  test("auto-installs when explicitly enabled", async () => {
    let called = false;
    const k = new PythonKernel({
      autoLoadPackages: true,
      load: async () => ({
        ...fake.runtime,
        async loadPackagesFromImports() {
          called = true;
        },
      }),
    });
    await k.run("import numpy");
    expect(called).toBe(true);
  });

  test("tolerates a runtime without package loading", async () => {
    const k = new PythonKernel({
      autoLoadPackages: true,
      load: async () => ({
        runPythonAsync: async () => undefined,
        setStdout: () => {},
        setStderr: () => {},
      }),
    });
    expect((await k.run("import numpy")).error).toBeUndefined();
  });
});

describe("restart", () => {
  test("returns to idle and reloads on the next run", async () => {
    const k = kernel();
    await k.run("1");
    expect(loadCount).toBe(1);

    await k.restart();
    expect(k.getStatus()).toBe("idle");

    await k.run("2");
    expect(loadCount).toBe(2);
  });
});

describe("normalise", () => {
  test("passes primitives through", () => {
    expect(normalise(1)).toBe(1);
    expect(normalise("s")).toBe("s");
    expect(normalise(true)).toBe(true);
    expect(normalise(null)).toBeNull();
  });

  test("describes a function rather than dropping it", () => {
    expect(normalise(() => 1)).toMatch(/function/);
  });

  test("describes a Pyodide proxy instead of throwing", () => {
    // Proxies cannot be structured-cloned into the page; the UI must still
    // show something meaningful.
    expect(normalise({ type: "DataFrame", toString: () => "   a  b\n0  1  2" })).toContain(
      "DataFrame",
    );
  });

  test("bounds a large array", () => {
    const big = Array.from({ length: 5000 }, (_, i) => i);
    expect((normalise(big) as unknown[]).length).toBe(1000);
  });
});
