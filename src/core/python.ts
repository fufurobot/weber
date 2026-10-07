/**
 * Python backend selection.
 *
 * Weber offers Python in two contexts, and conflating them is a source of
 * unfixable bug reports: "Python can't read my file" is true in the browser and
 * false on the server, and both are correct answers to different questions.
 *
 * So the choice is explicit and inspectable rather than implicit.
 */

export type PythonBackend = "pyodide" | "cpython" | "none";

export type PythonContext = "notebook" | "build" | "terminal";

export interface BackendAvailability {
  pyodideAvailable: boolean;
  /** Defaults to true: CPython is the runtime the server itself is running on. */
  cpythonAvailable?: boolean;
}

export interface BackendDescription {
  id: PythonBackend;
  label: string;
  available: boolean;
  runs: "browser" | "server" | "nowhere";
  /** What this backend cannot do — surfaced in the UI, not buried in docs. */
  limitations: string[];
}

/**
 * Choose a backend for a context.
 *
 * Notebook cells prefer Pyodide because they execute in the browser, where a
 * WASM runtime costs the server nothing and cannot be abused. Build tasks and
 * the terminal need the host filesystem and real processes, which Pyodide does
 * not have; there is no virtual filesystem mapping to `/workspaces` that would
 * make it a drop-in replacement.
 */
export function selectPythonBackend(
  context: PythonContext,
  availability: BackendAvailability,
): PythonBackend {
  const cpython = availability.cpythonAvailable ?? true;

  if (context === "notebook") {
    if (availability.pyodideAvailable) return "pyodide";
    return cpython ? "cpython" : "none";
  }

  // build and terminal always need the host.
  return cpython ? "cpython" : "none";
}

const DESCRIPTIONS: Record<PythonBackend, BackendDescription> = {
  pyodide: {
    id: "pyodide",
    label: "Python in your browser (Pyodide)",
    available: true,
    runs: "browser",
    limitations: [
      "Uses a virtual filesystem: it cannot read or write the host's /workspaces.",
      "No subprocesses, so it cannot shell out to pip, git or a compiler.",
      "Only packages with a WASM wheel can be installed.",
      "A long-running cell blocks the tab, not the server.",
    ],
  },
  cpython: {
    id: "cpython",
    label: "Python on the server (CPython)",
    available: true,
    runs: "server",
    limitations: [
      "Runs on the server, so it uses the host's filesystem and the server's CPU.",
      "Subject to the workspace quota and the command allow-list.",
      "Not available when the browser is offline.",
    ],
  },
  none: {
    id: "none",
    label: "Python unavailable",
    available: false,
    runs: "nowhere",
    limitations: [
      "No Python backend is configured for this deployment.",
      "Install Pyodide assets for in-browser use, or enable the server runtime.",
    ],
  },
};

export function describePythonBackend(id: PythonBackend): BackendDescription {
  // Copy the arrays so a caller cannot mutate the shared description.
  const d = DESCRIPTIONS[id];
  return { ...d, limitations: [...d.limitations] };
}

/** All backends, for a capability listing. */
export function allPythonBackends(): BackendDescription[] {
  return (["pyodide", "cpython"] as const).map(describePythonBackend);
}
