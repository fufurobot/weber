/**
 * Browser smoke test.
 *
 * Runs the built SPA in a real browser against a real server and asserts the
 * DOM a user actually sees.
 *
 * Why this exists: every previous UI claim was an HTTP check — the shell is
 * served, assets resolve, MIME types are correct. All of that is true of a
 * bundle that throws on its first line. Only executing the page distinguishes
 * a working app from a correct-looking set of files.
 *
 *   bun run browser:smoke
 *
 * Exits non-zero on any failure, so CI treats it like any other test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.WEBER_SMOKE_URL ?? "http://127.0.0.1:18100";
const ROOT = join(import.meta.dir, "..");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Check[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}

/** Start the real server, so this is not testing a fixture build. */
async function startServer(port: number, workspace: string): Promise<ChildProcess> {
  const server = spawn(
    process.execPath,
    ["run", "src/server/main.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        CORE_HOST: "127.0.0.1",
        WORKSPACE_ROOT: workspace,
        WEBER_WEB_ROOT: join(ROOT, "dist", "web"),
        WEBER_SEED: "1",
        // Deliberately unauthenticated: this checks rendering, and an auth
        // gate would replace the app with a login view.
        GITHUB_CLIENT_ID: "",
        WEBER_ALLOWED_LOGINS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  server.stdout?.on("data", (b: Buffer) => process.stdout.write(`    [server] ${b}`));
  server.stderr?.on("data", (b: Buffer) => process.stderr.write(`    [server] ${b}`));
  return server;
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main(): Promise<void> {
  const port = Number(new URL(BASE).port || 18100);
  const workspace = mkdtempSync(join(tmpdir(), "weber-smoke-"));
  let server: ChildProcess | undefined;
  let browser: import("playwright").Browser | undefined;

  try {
    console.log("Building the SPA...");
    const build = spawn(process.execPath, ["run", "build:web"], { cwd: ROOT, stdio: "inherit" });
    const buildCode = await new Promise<number>((r) => build.on("close", (c) => r(c ?? 1)));
    if (buildCode !== 0) {
      console.error("FAIL: build:web failed");
      process.exit(1);
    }

    console.log(`\nStarting the server on :${port}`);
    server = await startServer(port, workspace);
    if (!(await waitForServer(BASE))) {
      console.error("FAIL: server never became healthy");
      process.exit(1);
    }
    console.log("  server is healthy\n");

    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage();

    // Collected rather than thrown: the first error is usually the cause, and
    // a later assertion failure would hide it.
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    console.log("Checks:");
    const res = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30_000 });
    check("page loads", res?.ok() ?? false, `status ${res?.status()}`);

    // The shell renders "Loading Weber…" and then replaces it. If the bundle
    // throws, that placeholder stays and #root's children never appear.
    const rootHtml = await page.locator("#root").innerHTML();
    check(
      "the app rendered into #root",
      rootHtml.length > 0 && !rootHtml.includes("Loading Weber"),
      rootHtml.slice(0, 120),
    );

    check("the brand is visible", await page.locator(".brand").isVisible());
    check(
      "the brand reads Weber",
      (await page.locator(".brand").textContent())?.trim() === "Weber",
    );

    // The health probe populates #meta, so a non-empty value proves the app
    // reached the API, not merely that it rendered.
    const meta = (await page.locator("#meta").textContent()) ?? "";
    check(
      "the app reached the backend",
      meta.length > 0 && !meta.includes("unreachable"),
      `#meta = ${JSON.stringify(meta)}`,
    );

    check("both modes are offered", (await page.getByText("Project Mode").count()) > 0);
    check("Project Mode is the default", await page.locator(".tab.active").first().isVisible());

    // Project Mode renders the file tree from the seeded workspace.
    await page.waitForTimeout(1500);
    const rows = await page.locator(".tree-row").count();
    check("the file tree listed the seeded workspace", rows > 0, `${rows} rows`);

    // Switch to Script Mode, which mounts the notebook.
    await page.getByText("Script Mode").click();
    await page.waitForTimeout(800);
    check("Script Mode renders a notebook", (await page.locator(".notebook").count()) > 0);

    // A top-level bundle error would leave these populated while the page
    // still looked structurally fine.
    check(
      "no uncaught page errors",
      pageErrors.length === 0,
      pageErrors.slice(0, 2).join(" | "),
    );
    check(
      "no console errors",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(" | "),
    );

    // Capture evidence for a failure, since CI logs are all anyone will see.
    await page.screenshot({ path: join(ROOT, "browser-smoke.png"), fullPage: true });
    console.log("\n  screenshot: browser-smoke.png");
  } finally {
    await browser?.close().catch(() => {});
    server?.kill();
    rmSync(workspace, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`\nFAILED: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}

await main();
