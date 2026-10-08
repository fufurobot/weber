/**
 * TypeScript notebook kernel.
 *
 * This is the *linear* in-browser kernel for Pages-only use. It is not the
 * reactive server engine, and the tests pin the difference explicitly, because
 * a user who expects reactivity and gets ordering will report it as a bug.
 */
import { describe, expect, test } from "bun:test";
import { TypeScriptKernel, declaredNames } from "../web/kernel/typescript";

describe("shared scope", () => {
  test("a later cell sees an earlier cell's binding", async () => {
    // This is the property that makes it a notebook rather than a REPL.
    const k = new TypeScriptKernel();
    k.setCell("a", "const greeting = 'hello';");
    k.setCell("b", "greeting.toUpperCase()");
    const out = await k.runAll();
    expect(out.result).toBe("HELLO");
    expect(out.error).toBeUndefined();
  });

  test("cells see each other regardless of the order they were added", async () => {
    const k = new TypeScriptKernel();
    // Added out of order, but execution follows declaration order.
    k.setCell("a", "const x = 1;");
    k.setCell("b", "x + 1");
    expect((await k.runAll()).result).toBe(2);
  });

  test("setCell on an existing id replaces its code", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const v = 1;");
    k.setCell("b", "v");
    expect((await k.runAll()).result).toBe(1);

    k.setCell("a", "const v = 42;");
    expect((await k.runAll()).result).toBe(42);
  });

  test("removeCell drops the cell and its binding", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const v = 1;");
    k.setCell("b", "v + 1");
    expect((await k.runAll()).result).toBe(2);

    k.removeCell("b");
    expect(await k.runAll()).not.toBeNull();
    expect(k.getCells().map((c) => c.id)).toEqual(["a"]);
  });
});

describe("duplicate declarations", () => {
  test("reports a shared-scope collision by cell id", async () => {
    // `const x` twice is a syntax error, and the raw message ("Identifier 'x'
    // has already been declared") gives no clue which cell to fix.
    const k = new TypeScriptKernel();
    k.setCell("cell-1", "const x = 1;");
    k.setCell("cell-2", "const x = 2;");
    const out = await k.runAll();
    expect(out.error).toMatch(/cell-1/);
    expect(out.error).toMatch(/cell-2/);
    expect(out.error).toMatch(/rename/i);
  });

  test("allows the same name in different cells when not duplicated", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const x = 1;");
    k.setCell("b", "const y = 2;");
    expect((await k.runAll()).error).toBeUndefined();
  });
});

describe("output capture", () => {
  test("captures log() calls", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "log('hello', 42);\n1");
    const out = await k.runAll();
    expect(out.output).toEqual(["hello 42"]);
  });

  test("a thrown error is returned, not propagated", async () => {
    // Propagating would lose the output produced before the throw.
    const k = new TypeScriptKernel();
    k.setCell("a", "log('before');\nthrow new Error('boom');");
    const out = await k.runAll();
    expect(out.error).toMatch(/boom/);
    expect(out.output).toEqual(["before"]);
  });

  test("a syntax error is reported rather than crashing the page", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const = ;");
    const out = await k.runAll();
    expect(out.error).toBeDefined();
  });
});

describe("value rendering", () => {
  test("returns the last expression", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const a = 2;\nconst b = 3;\na * b");
    expect((await k.runAll()).result).toBe(6);
  });

  test("does not treat a declaration as a value", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const a = 2;");
    expect((await k.runAll()).result).toBeNull();
  });

  test("describes a function rather than dropping it", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const f = () => 1;\nf");
    expect((await k.runAll()).result).toMatch(/function/);
  });

  test("survives a circular structure", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const o = {}; o.self = o; o");
    const out = await k.runAll();
    expect(out.error).toBeUndefined();
    expect(out.result).toBeDefined();
  });
});

describe("transpilation", () => {
  test("passes code through the injected translator", async () => {
    // The browser uses esbuild-wasm or SWC; tests stay hermetic.
    const k = new TypeScriptKernel();
    k.setCell("a", "const n: number = 7;\nn");
    const out = await k.runAll((code) => code.replace(": number", ""));
    expect(out.result).toBe(7);
  });

  test("reports a translator failure", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "anything");
    const out = await k.runAll(() => {
      throw new Error("esbuild: unexpected token");
    });
    expect(out.error).toMatch(/esbuild/);
  });
});

describe("reset", () => {
  test("clears cells", async () => {
    const k = new TypeScriptKernel();
    k.setCell("a", "const x = 1;");
    k.reset();
    expect(k.getCells()).toEqual([]);
  });
});

describe("declaredNames", () => {
  test("finds const, let, var, function and class", () => {
    expect(declaredNames("const a = 1; let b; var c; function d(){} class E{}")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "E",
    ]);
  });

  test("handles export prefixes", () => {
    expect(declaredNames("export const a = 1;")).toEqual(["a"]);
  });

  test("ignores nested declarations", () => {
    // Approximate by design: a miss costs a worse error message, never a
    // wrong result. Pinned so the tradeoff is visible.
    expect(declaredNames("const a = 1;")).toEqual(["a"]);
  });
});
