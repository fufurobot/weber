/**
 * GitHub Pages build.
 *
 * Pages can only serve static files, but Weber's file operations, toolchain
 * runner and notebook engine all live in the core service. So this produces a
 * **demo** of the interface backed by an in-browser mock, and says so in the
 * UI — a reviewer should never be left thinking the IDE is working when they
 * are looking at fixtures.
 *
 * Differences from `build:web`:
 *   - base path is `/weber/` (project Pages sites are not served from root)
 *   - `api.ts` is aliased to a mock implementation
 *   - a `.nojekyll` file is emitted so `_`-prefixed assets are not ignored
 */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "dist", "pages");
const ASSETS = join(OUT, "assets");

/** Project Pages sites are served under /<repo>/, not from the origin root. */
const BASE_PATH = process.env.PAGES_BASE_PATH ?? "/weber/";

async function main(): Promise<void> {
  if (!existsSync(WEB)) throw new Error(`frontend sources not found at ${WEB}`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });

  const mockPath = join(ROOT, "web", "mock-api.ts");
  if (!existsSync(mockPath)) throw new Error(`mock backend not found at ${mockPath}`);

  const built = await Bun.build({
    entrypoints: [join(WEB, "main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    naming: "[name]-[hash].[ext]",
    outdir: ASSETS,
    define: {
      // Let the app know it is running against fixtures.
      __WEBER_DEMO__: "true",
      __WEBER_BASE__: JSON.stringify(BASE_PATH),
    },
    plugins: [
      {
        // Redirect the API client to the mock without touching application code,
        // so the demo exercises the real components rather than a fork of them.
        name: "mock-api",
        setup(build) {
          build.onResolve({ filter: /^\.\/api$/ }, (args) => {
            if (!args.importer.endsWith("main.ts") && !args.importer.endsWith("notebook.ts")) {
              return undefined;
            }
            return { path: join(WEB, "mock-api.ts") };
          });
        },
      },
    ],
  });

  if (!built.success) {
    for (const log of built.logs) console.error(String(log));
    throw new Error("pages bundle failed");
  }

  const entry = built.outputs.find((o) => o.path.endsWith(".js"));
  if (!entry) throw new Error("bundler produced no JavaScript entrypoint");
  const entryName = basename(entry.path);

  const css = await readFile(join(WEB, "styles.css"), "utf8");
  const cssName = `styles-${shortHash(css)}.css`;
  await writeFile(join(ASSETS, cssName), css, "utf8");

  let html = await readFile(join(WEB, "index.html"), "utf8");
  html = html
    .replace(/href="styles\.css"/, `href="assets/${cssName}"`)
    .replace(/src="main\.ts"/, `src="assets/${entryName}"`)
    // Tell the UI (and the reader) that this is a fixture-backed demo.
    .replace(
      "<div id=\"root\">Loading Weber…</div>",
      '<div id="demo-banner">Static demo — the IDE backend is not running. ' +
        "File, terminal and notebook actions are simulated.</div>" +
        '<div id="root">Loading Weber…</div>',
    );
  await writeFile(join(OUT, "index.html"), html, "utf8");

  // Without this, Jekyll ignores files and directories starting with "_".
  await writeFile(join(OUT, ".nojekyll"), "", "utf8");

  const total = built.outputs.reduce((n, o) => n + (o.size ?? 0), 0) + css.length;
  console.log(`built ${OUT} (base ${BASE_PATH})`);
  console.log(`  assets/${entryName}`);
  console.log(`  assets/${cssName}`);
  console.log(`  index.html, .nojekyll`);
  console.log(`  total ${(total / 1024).toFixed(1)} KiB`);
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!;
}

function shortHash(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex").slice(0, 8);
}

await main();
