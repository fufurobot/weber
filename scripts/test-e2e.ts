/**
 * Dedicated e2e pass.
 *
 * Runs only the tests that need real child processes (or a live stack), which
 * the default `bun test` deliberately skips. See tests/helpers.ts.
 *
 *   bun run test:e2e
 */
import { spawn } from "node:child_process";

const args = ["test", ...process.argv.slice(2)];
const env = { ...process.env, WEBER_E2E_MODE: "1", WEBER_FORCE_E2E: "1" };

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env,
  // `bun` is resolved from PATH; process.execPath is the bun binary itself.
});

child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("failed to launch the test runner:", err.message);
  process.exit(1);
});
