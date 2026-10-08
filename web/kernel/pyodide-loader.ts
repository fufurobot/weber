/**
 * Pyodide loader.
 *
 * Kept separate from `PythonKernel` so the kernel stays testable without a
 * network, and so the CDN and version are visible in one place.
 *
 * Pyodide is fetched from a CDN rather than bundled: it is ~6.4 MB of WASM
 * plus a package index, and the Pages deployment has no build step that could
 * usefully inline it. Pinning the version matters — the ABI changes between
 * releases, and an unpinned CDN URL would break the notebook without any
 * change to this repository.
 */

/** Pinned deliberately. See the note above about ABI drift. */
export const PYODIDE_VERSION = "0.26.2";

export function pyodideUrl(version = PYODIDE_VERSION): string {
  return `https://cdn.jsdelivr.net/pyodide/v${version}/full/pyodide.mjs`;
}

interface PyodideModule {
  loadPyodide(options: { indexURL: string }): Promise<unknown>;
}

/**
 * Load Pyodide from the CDN.
 *
 * A dynamic `import()` of a URL is used rather than a `<script>` tag so the
 * load is a promise and failures are catchable. `/* @vite-ignore *\/`-style
 * comments are absent because this is bundled by Bun, which leaves dynamic
 * imports of absolute URLs alone.
 */
export async function loadPyodideFromCdn(version = PYODIDE_VERSION): Promise<any> {
  const url = pyodideUrl(version);
  const indexURL = url.slice(0, url.lastIndexOf("/") + 1);

  const mod = (await import(/* @vite-ignore */ url)) as PyodideModule;
  return mod.loadPyodide({ indexURL });
}

/**
 * Whether Pyodide can plausibly run here.
 *
 * Returns a reason rather than a boolean so the UI can explain *why* Python is
 * unavailable instead of silently hiding it.
 */
export function pyodideSupport(): { supported: boolean; reason?: string } {
  if (typeof WebAssembly === "undefined") {
    return { supported: false, reason: "This browser does not support WebAssembly." };
  }
  if (typeof document === "undefined") {
    return { supported: false, reason: "Python runs in the browser, so it needs a page." };
  }
  return { supported: true };
}
