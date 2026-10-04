/**
 * Starter workspace seeding — the answer to issue #8.
 *
 * A first-time user otherwise opens an empty IDE with no indication of what to
 * do. The danger in seeding is not writing files; it is writing them *into
 * someone's existing work*. So the rule here is conservative:
 *
 *   - a workspace with any content at all is left completely alone
 *   - an individual file is never overwritten, even under `force`
 *
 * "Empty" means no entries whatsoever, including directories: a folder the
 * user created is intent, and seeding into it would be surprising.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface SeedResult {
  /** True when this call wrote the starter content. */
  seeded: boolean;
  /** Root-relative paths actually written, never pre-existing files. */
  written: string[];
}

export interface SeedOptions {
  /** Seed even when the workspace is non-empty. Never overwrites files. */
  force?: boolean;
}

/**
 * Starter files, keyed by workspace-relative path.
 *
 * One file per advertised language, plus a notebook, so every mode has
 * something to open. Deliberately tiny: this is a signpost, not a tutorial.
 */
export const STARTER_FILES: Record<string, string> = {
  "README.md": `# Welcome to Weber

You are looking at a starter workspace. Everything here is yours to edit or
delete — it exists so no mode opens on an empty screen.

## Project Mode

The file tree on the left is this workspace. Click a file to edit it, right
click to delete, and use the toolbar to create files and folders.

Try opening \`src/hello.ts\` and pressing Save.

## Script Mode

Switch tabs at the top to open the reactive notebook. Cells are ordinary
TypeScript, but they re-run when their inputs change: edit the first cell's
\`greeting\` and watch the dependent cell update.

The notebook engine reports which cells ran, which were skipped, and why —
so reactivity is something you can see rather than guess at.

## Languages

| File | Toolchain |
|---|---|
| \`src/hello.ts\` | Bun / TypeScript |
| \`src/hello.rs\` | rustc, cargo |
| \`src/hello.c\` | clang, clangd |
| \`src/hello.py\` | CPython on the server, Pyodide in the browser |

The toolchain chips above the editor show which of these are installed in the
container. Missing ones are reported rather than failing at build time.
`,

  "src/hello.ts": `/**
 * TypeScript, running on Bun.
 *
 * Run it from the terminal:
 *   bun run src/hello.ts
 */
export function greet(name: string): string {
  return \`hello, \${name}\`;
}

if (import.meta.main) {
  console.log(greet("weber"));
}
`,

  "src/hello.rs": `// Rust. Build with cargo, or compile directly with rustc.
fn main() {
    println!("hello, weber");
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}
`,

  "src/hello.c": `/* C. Compile with clang, or to WebAssembly with wasmchain. */
#include <stdio.h>

int main(void) {
    printf("hello, weber\\n");
    return 0;
}
`,

  "src/hello.py": `"""Python.

In Script Mode this runs in your browser via Pyodide; from the terminal it runs
against the server's CPython. The two have different capabilities, which the UI
makes visible rather than hiding.
"""


def greet(name: str) -> str:
    return f"hello, {name}"


if __name__ == "__main__":
    print(greet("weber"))
`,

  "notebook.ts": `// This file is a scratchpad; Script Mode is where notebooks live.
const greeting = "hello weber";
`,
};

/**
 * Seed `root` with the starter workspace.
 *
 * Safe to call on every boot: a workspace that already has anything in it is
 * left untouched, and no individual file is ever overwritten.
 */
export async function seedStarterWorkspace(
  root: string,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const exists = await pathExists(root);

  if (exists && !options.force) {
    const entries = await fs.readdir(root);
    if (entries.length > 0) {
      // Someone's workspace. Do not touch it, not even to add a README.
      return { seeded: false, written: [] };
    }
  } else if (!exists) {
    await fs.mkdir(root, { recursive: true });
  }

  const written: string[] = [];

  for (const [rel, content] of Object.entries(STARTER_FILES)) {
    const target = join(root, ...rel.split("/"));

    // Never clobber: an existing file is the user's, whatever `force` says.
    if (await pathExists(target)) continue;

    const parent = target.slice(0, Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")));
    if (parent) await fs.mkdir(parent, { recursive: true });

    await fs.writeFile(target, content, "utf8");
    written.push(rel);
  }

  return { seeded: written.length > 0, written };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
