/**
 * CI workflow structure.
 *
 * The workflow is the thing that decides whether a regression reaches main, so
 * a malformed or silently-truncated job list is worth catching locally rather
 * than discovering from a green-but-empty run.
 *
 * Dependency-free: no YAML library, just the indentation-aware reading that is
 * enough to verify our own file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const src = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

/** Top-level `jobs:` children (two-space indented keys). */
function jobNames(): string[] {
  const lines = src.split(/\r?\n/);
  const names: string[] = [];
  let inJobs = false;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    // Any other top-level key ends the jobs block.
    if (inJobs && /^\S/.test(line) && line.trim() !== "") break;
    if (inJobs) {
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (m) names.push(m[1]!);
    }
  }
  return names;
}

/** Top-level keys, excluding the comment and blank noise. */
function topLevelKeys(): string[] {
  return src
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_-]*:/.test(l))
    .map((l) => l.slice(0, l.indexOf(":")));
}

describe("workflow structure", () => {
  test("has the expected top-level keys", () => {
    const keys = topLevelKeys();
    expect(keys).toContain("name");
    expect(keys).toContain("on");
    expect(keys).toContain("jobs");
  });

  test("declares every job the project needs", () => {
    const jobs = jobNames();
    for (const expected of ["test", "e2e", "compose", "chart", "combined"]) {
      expect(jobs).toContain(expected);
    }
  });

  test("contains no tabs, which YAML forbids", () => {
    expect(src).not.toMatch(/\t/);
  });

  test("every job declares a runner", () => {
    const blocks = src.split(/\n {2}(?=[A-Za-z0-9_-]+:\s*$)/m).slice(1);
    const jobsBlock = src.slice(src.indexOf("\njobs:"));
    const jobChunks = jobsBlock.split(/\n {2}(?=[A-Za-z0-9_-]+:\s*$)/m).slice(1);
    expect(jobChunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of jobChunks) {
      expect(chunk).toMatch(/runs-on:/);
    }
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("CI runs the deployment the way a PaaS does", () => {
    // One process, no edge, the platform's PORT. Reading a Dockerfile proves
    // nothing about whether the deployment works.
    expect(src).toMatch(/PORT=18080/);
    expect(src).toMatch(/core serves the SPA/);
  });

  test("CI asserts auth gates execution but not health or the shell", () => {
    // Health must stay public or the platform healthcheck fails the release;
    // the shell must stay public or the login page cannot load.
    expect(src).toMatch(/command execution gated/);
    expect(src).toMatch(/health and the shell stay public/);
  });
});

describe("safety assertions", () => {
  test("typecheck blocks the build rather than advising", () => {
    // It was advisory once, and in that window it caught a real unreachable
    // branch that tests passed over. A check that cannot fail is not a check.
    expect(src).toMatch(/name: Typecheck/);
    const typecheckBlock = src.slice(src.indexOf("name: Typecheck"));
    const nextStep = typecheckBlock.indexOf("- name:", 10);
    const block = typecheckBlock.slice(0, nextStep > 0 ? nextStep : 400);
    expect(block).not.toMatch(/continue-on-error/);
  });

  test("CI proves the chart refuses an unauthenticated public deployment", () => {
    // This is the regression guard for the chart's most important property.
    expect(src).toMatch(/Exposing without auth must be refused/);
    expect(src).toMatch(/--set ingress\.enabled=true > \/dev\/null 2>&1/);
  });

  test("CI proves an empty allow-list is refused", () => {
    expect(src).toMatch(/An empty allow-list must be refused/);
  });

  test("CI proves a full configuration still renders", () => {
    // A chart that refuses everything is useless; the negative tests need a
    // positive counterpart or they would pass on a chart that never renders.
    expect(src).toMatch(/A fully configured deployment must render/);
  });

  test("CI asserts nothing is exposed by default", () => {
    expect(src).toMatch(/Assert nothing is publicly exposed by default/);
  });
});
