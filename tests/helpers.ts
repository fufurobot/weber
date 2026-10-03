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
 */
export function e2e(name: string, fn: () => void | Promise<void>): void {
  if (e2eMode) {
    bunTest(name, fn);
    return;
  }
  bunTest.skip(`${name} [needs process spawn — run: bun run test:e2e]`, fn);
}
