/**
 * Python execution backends.
 *
 * Weber advertises Python in two places, and they are not interchangeable:
 *
 *   - the **notebook** (Script Mode) wants a fast, safe, client-side runtime
 *   - **build tasks** want real CPython with the host filesystem
 *
 * Pyodide can only do the first. This module makes the choice explicit rather
 * than implicit, because "Python works" meaning two different things depending
 * on where you clicked is exactly the kind of ambiguity that produces bug
 * reports nobody can reproduce.
 */
import { describe, expect, test } from "bun:test";
import { describePythonBackend, selectPythonBackend } from "../src/core/python";

describe("backend selection", () => {
  test("prefers Pyodide for notebook cells, since they run in the browser", () => {
    expect(selectPythonBackend("notebook", { pyodideAvailable: true })).toBe("pyodide");
  });

  test("uses CPython for build tasks, which need a real filesystem", () => {
    // Pyodide has a virtual filesystem; it cannot see /workspaces.
    expect(selectPythonBackend("build", { pyodideAvailable: true })).toBe("cpython");
  });

  test("falls back to CPython when Pyodide is unavailable", () => {
    expect(selectPythonBackend("notebook", { pyodideAvailable: false })).toBe("cpython");
  });

  test("reports when neither backend is usable, rather than pretending", () => {
    expect(selectPythonBackend("notebook", { pyodideAvailable: false, cpythonAvailable: false })).toBe(
      "none",
    );
    expect(selectPythonBackend("build", { pyodideAvailable: true, cpythonAvailable: false })).toBe(
      "none",
    );
  });

  test("defaults to assuming CPython exists, as it is the server runtime", () => {
    expect(selectPythonBackend("build", { pyodideAvailable: false })).toBe("cpython");
  });
});

describe("backend description", () => {
  test("states Pyodide's limitation plainly", () => {
    // A user who cannot read a file will otherwise file a bug about the sandbox.
    const d = describePythonBackend("pyodide");
    expect(d.label).toMatch(/browser/i);
    expect(d.limitations.join(" ")).toMatch(/virtual filesystem|no host/i);
    expect(d.limitations.join(" ")).toMatch(/no subprocess|subprocesses/i);
  });

  test("states CPython's differences plainly", () => {
    const d = describePythonBackend("cpython");
    expect(d.limitations.join(" ")).toMatch(/server|host/i);
  });

  test("the none backend explains why nothing is available", () => {
    const d = describePythonBackend("none");
    expect(d.available).toBe(false);
    expect(d.label.length).toBeGreaterThan(0);
  });

  test("every backend declares whether it is available and where it runs", () => {
    for (const id of ["pyodide", "cpython", "none"] as const) {
      const d = describePythonBackend(id);
      expect(typeof d.available).toBe("boolean");
      expect(["browser", "server", "nowhere"]).toContain(d.runs);
    }
  });

  test("Pyodide is not claimed to need the network, since it is a WASM runtime", () => {
    // Installed from a CDN once, but execution itself is local.
    expect(describePythonBackend("pyodide").limitations.join(" ")).not.toMatch(/requires network/i);
  });
});
