/**
 * File the follow-ups in docs/ISSUES.md as GitHub issues.
 *
 * The token available when this repository was bootstrapped is read-only, so
 * the issues could not be filed at the time. This script exists so they can be
 * filed in one step once a token with `Issues: write` is provided.
 *
 *   GITHUB_TOKEN=github_pat_... bun run scripts/file-issues.ts [--dry-run]
 *
 * Labels are applied only if they already exist; GitHub rejects unknown label
 * names, and failing the whole run over a missing label would be unhelpful.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OWNER_REPO = process.env.GITHUB_REPOSITORY ?? "fufurobot/weber";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const DRY_RUN = process.argv.includes("--dry-run");
const API = "https://api.github.com";

interface Issue {
  title: string;
  labels: string[];
  body: string;
}

/** Parse `## <title>` sections from the issues document. */
export function parseIssues(markdown: string): Issue[] {
  const issues: Issue[] = [];
  const lines = markdown.split(/\r?\n/);

  let current: { title: string; labels: string[]; body: string[] } | null = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(?:P\d+\s+—\s+)?(.+)$/);
    if (heading) {
      if (current) issues.push(finish(current));
      current = { title: heading[1]!.trim(), labels: [], body: [] };
      continue;
    }
    if (!current) continue;

    const labels = line.match(/^\*\*Labels:\*\*\s*(.+)$/);
    if (labels) {
      current.labels = labels[1]!
        .split(",")
        .map((l) => l.trim().replace(/`/g, ""))
        .filter(Boolean);
      continue;
    }
    current.body.push(line);
  }
  if (current) issues.push(finish(current));
  return issues;
}

function finish(c: { title: string; labels: string[]; body: string[] }): Issue {
  return { title: c.title, labels: c.labels, body: c.body.join("\n").trim() };
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "weber-issue-filer",
      ...(init?.headers ?? {}),
    },
  });
}

async function existingLabels(): Promise<Set<string>> {
  const res = await gh(`/repos/${OWNER_REPO}/labels?per_page=100`);
  if (!res.ok) return new Set();
  const list = (await res.json()) as { name: string }[];
  return new Set(list.map((l) => l.name));
}

async function main(): Promise<void> {
  const doc = readFileSync(join(ROOT, "docs", "ISSUES.md"), "utf8");
  const issues = parseIssues(doc);

  if (issues.length === 0) {
    console.error("no issues parsed from docs/ISSUES.md");
    process.exit(1);
  }

  console.log(`parsed ${issues.length} issue(s) from docs/ISSUES.md`);
  for (const issue of issues) {
    console.log(`  - ${issue.title}  [${issue.labels.join(", ")}]`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing was filed");
    return;
  }
  if (!TOKEN) {
    console.error("\nGITHUB_TOKEN is not set. Provide a token with Issues: write.");
    process.exit(1);
  }

  const known = await existingLabels();
  let filed = 0;

  for (const issue of issues) {
    const labels = issue.labels.filter((l) => known.has(l));
    const skipped = issue.labels.filter((l) => !known.has(l));

    const res = await gh(`/repos/${OWNER_REPO}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: issue.title, body: issue.body, labels }),
    });

    if (res.status === 201) {
      const created = (await res.json()) as { number: number; html_url: string };
      console.log(`  filed #${created.number}: ${issue.title}`);
      if (skipped.length > 0) console.log(`    (skipped unknown labels: ${skipped.join(", ")})`);
      filed++;
    } else {
      const err = await res.text();
      console.error(`  FAILED: ${issue.title} -> ${res.status} ${err}`);
    }
  }

  console.log(`\nfiled ${filed}/${issues.length}`);
  if (filed < issues.length) process.exit(1);
}

// Only run when executed directly, so the parser stays testable.
if (import.meta.main) {
  await main();
}
