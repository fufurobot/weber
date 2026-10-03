/**
 * Frontend build.
 *
 * Produces `dist/web` — the directory `compose/Dockerfile.web` copies into
 * nginx. Uses Bun's own bundler so the image needs no Node toolchain.
 *
 * Assets are emitted with a content hash under `assets/` so the nginx config
 * can serve them as immutable, while `index.html` stays uncached. The shell's
 * asset URLs are rewritten to point at the hashed files.
 */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "dist", "web");
const ASSETS = join(OUT, "assets");

async function main(): Promise<void> {
  if (!existsSync(WEB)) {
    throw new Error(`frontend sources not found at ${WEB}`);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });

  // --- bundle the application -------------------------------------------
  const built = await Bun.build({
    entrypoints: [join(WEB, "main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    naming: "[name]-[hash].[ext]",
    outdir: ASSETS,
  });

  if (!built.success) {
    for (const log of built.logs) console.error(String(log));
    throw new Error("frontend bundle failed");
  }

  const entry = built.outputs.find((o) => o.path.endsWith(".js"));
  if (!entry) throw new Error("bundler produced no JavaScript entrypoint");
  const entryName = basename(entry.path);

  // --- stylesheet --------------------------------------------------------
  const css = await readFile(join(WEB, "styles.css"), "utf8");
  const cssName = `styles-${shortHash(css)}.css`;
  await writeFile(join(ASSETS, cssName), css, "utf8");

  // --- html shell --------------------------------------------------------
  let html = await readFile(join(WEB, "index.html"), "utf8");
  html = html
    .replace(/href="styles\.css"/, `href="assets/${cssName}"`)
    .replace(/src="main\.ts"/, `src="assets/${entryName}"`);
  await writeFile(join(OUT, "index.html"), html, "utf8");

  // --- report ------------------------------------------------------------
  const total = built.outputs.reduce((n, o) => n + (o.size ?? 0), 0) + css.length;
  console.log(`built ${OUT}`);
  console.log(`  assets/${entryName}`);
  console.log(`  assets/${cssName}`);
  console.log(`  index.html`);
  console.log(`  total ${(total / 1024).toFixed(1)} KiB`);
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1]!;
}

/** Short content hash, so an unchanged file keeps its name and stays cached. */
function shortHash(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex").slice(0, 8);
}

await main();
