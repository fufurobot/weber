/**
 * Static file serving for standalone deployments.
 *
 * Under compose, nginx serves the built SPA and proxies /api and /ws. A
 * standalone deployment has no edge, so the core serves the same files —
 * otherwise `GET /` 404s and the only way to reach the product is to know the
 * API paths by hand.
 *
 * Extracted from the entrypoint specifically so it can be tested: an earlier
 * version guarded on `Bun.file(<directory>).exists()`, which is always false,
 * so static serving silently did nothing while every other test passed.
 */

export type StaticHandler = (pathname: string) => Promise<Response | null>;

/** Build a handler rooted at `webRoot`, or null-returning when it is absent. */
export function createStaticHandler(webRoot: string): StaticHandler {
  // Trailing slashes would produce double separators in every path below.
  const root = webRoot.replace(/\/+$/, "");

  return async function serve(pathname: string): Promise<Response | null> {
    // Guard on a FILE, never the directory: `Bun.file(<dir>).exists()` is false.
    const index = Bun.file(`${root}/index.html`);
    if (!(await index.exists())) return null;

    let rel: string;
    try {
      // Decode first, so `%2e%2e` cannot smuggle a traversal past the check.
      rel = decodeURIComponent(pathname);
    } catch {
      return null; // malformed encoding
    }

    rel = rel === "/" ? "index.html" : rel.replace(/^\/+/, "");
    if (rel.includes("..") || rel.includes("\0")) return null;

    const file = Bun.file(`${root}/${rel}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          // Hashed filenames are content-addressed, so they can be cached hard;
          // the shell must never be cached or a deploy would not take effect.
          "cache-control": rel.startsWith("assets/")
            ? "public, max-age=31536000, immutable"
            : "no-store, must-revalidate",
        },
      });
    }

    // SPA history fallback for client-side routes — but never for a missing
    // file, which would turn a typo'd asset URL into a 200 of HTML.
    if (!rel.includes(".")) {
      return new Response(index, { headers: { "cache-control": "no-store" } });
    }
    return null;
  };
}
