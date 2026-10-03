/**
 * Issue-filing tooling.
 *
 * The follow-ups live in docs/ISSUES.md because the available API token is
 * read-only. These tests keep that document machine-readable, so filing them
 * later is one command rather than a manual copy-paste of nine issues.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIssues } from "../scripts/file-issues";

const ROOT = join(import.meta.dir, "..");
const doc = readFileSync(join(ROOT, "docs", "ISSUES.md"), "utf8");

describe("parseIssues", () => {
  test("parses each issue heading in the real document", () => {
    const issues = parseIssues(doc);
    expect(issues.length).toBeGreaterThanOrEqual(8);
    for (const issue of issues) {
      expect(issue.title.length).toBeGreaterThan(3);
      expect(issue.body.length).toBeGreaterThan(0);
    }
  });

  test("strips the priority prefix from titles", () => {
    const issues = parseIssues(doc);
    for (const issue of issues) {
      expect(issue.title).not.toMatch(/^P\d+\s+—/);
    }
  });

  test("extracts labels from the Labels line", () => {
    const issues = parseIssues(doc);
    const sandbox = issues.find((i) => i.title.includes("WEBER_SANDBOX"));
    expect(sandbox).toBeDefined();
    expect(sandbox!.labels).toContain("security");
  });

  test("keeps acceptance criteria in the body", () => {
    const issues = parseIssues(doc);
    expect(issues.some((i) => i.body.includes("Acceptance criteria"))).toBe(true);
  });

  test("parses a hand-written fragment", () => {
    const issues = parseIssues(
      [
        "## P1 — First problem",
        "**Labels:** alpha, beta",
        "",
        "Body text here.",
        "",
        "## Second problem",
        "**Labels:** gamma",
        "",
        "More text.",
      ].join("\n"),
    );
    expect(issues.map((i) => i.title)).toEqual(["First problem", "Second problem"]);
    expect(issues[0]!.labels).toEqual(["alpha", "beta"]);
    expect(issues[1]!.body).toContain("More text.");
  });

  test("ignores headings that are not issues", () => {
    const issues = parseIssues("# Title\n\nIntro text.\n\n## Real issue\nBody.\n");
    expect(issues.map((i) => i.title)).toEqual(["Real issue"]);
  });

  test("every issue names a verification step or an acceptance criterion", () => {
    // An issue without a definition of done is not actionable.
    for (const issue of parseIssues(doc)) {
      expect(issue.body).toMatch(/Acceptance criteria|acceptance criteria/);
    }
  });
});
