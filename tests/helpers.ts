/**
 * Test-environment helpers.
 *
 * Weber has two kinds of tests:
 *
 *   bun test            unit + policy tests. Fully hermetic: no child
 *                       processes, no network, no container runtime.
 *   bun run test:e2e    tests that need to spawn real processes, so they only
 *                       run where that is permitted.
 *
 * The DSH Windows sandbox blocks spawning a child with piped stdio (EPERM),
 * which is a documented boundary rather than a defect. Tests that need a real
 * process are therefore declared with `e2e(...)`: the default suite skips them
 * so it never reports an environment artefact as a product failure.
 */
import { test as bunTest } from "bun:test";

/** True when this run is the dedicated e2e pass. */
export const e2eMode: boolean = process.env.WEBER_E2E_MODE === "1";

/**
 * Declare a test that requires spawning a real process.
 *
 * Skipped in the default suite, executed under `bun run test:e2e`.
 *
 * `timeoutMs` matters here: spawning is far slower than an in-process
 * assertion, and a test that does several spawns can exceed Bun's 5s default
 * on a loaded CI runner. That failure looks like a product bug but is a
 * mis-sized timeout, so set it deliberately.
 */
export function e2e(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void {
  const options = timeoutMs === undefined ? undefined : { timeout: timeoutMs };
  if (e2eMode) {
    bunTest(name, fn, options);
    return;
  }
  bunTest.skip(`${name} [needs process spawn — run: bun run test:e2e]`, fn, options);
}
