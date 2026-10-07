/**
 * Fetch ml-hub files through the GitHub API and decode them.
 *
 * raw.githubusercontent.com is unreachable from this environment, but the
 * contents API is, and it returns base64. This exists so the merge is based on
 * what ml-hub actually contains rather than on recollection.
 */
const TOKEN = (process.env.GITHUB_TOKEN ?? "").trim();
const REPO = "ml-tooling/ml-hub";

async function fetchFile(path: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "weber",
    },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (!body.content) throw new Error(`${path}: no content`);
  return Buffer.from(body.content, "base64").toString("utf8");
}

const wanted = process.argv.slice(2);
if (wanted.length === 0) {
  console.error("usage: bun run fetch-mlhub.ts <path> [path...]");
  process.exit(1);
}

for (const path of wanted) {
  try {
    console.log(`\n===== ${path} =====`);
    console.log(await fetchFile(path));
  } catch (err) {
    console.error(`!! ${(err as Error).message}`);
  }
}
