# Contributing to Weber

Thanks for your interest. This document covers how to work on Weber and what
the project expects from a change.

---

## Getting started

Weber runs on [Bun](https://bun.sh). No other toolchain is required to work on
the core or the frontend.

```bash
git clone https://github.com/fufurobot/weber.git
cd weber

bun install

# Run the test suite (hermetic: no child processes, no network)
bun test

# Start the core service with the development workspace
CORE_PORT=8787 WORKSPACE_ROOT=./workspaces bun run dev

# Build the frontend into dist/web
bun run build:web
```

To run the whole stack, use a container runtime:

```bash
cp compose/.env.example compose/.env
podman-compose up --build     # then open http://localhost:3000
```

---

## The two test suites

This is the most important convention in the repository.

| Command | Contents | Hermetic |
|---|---|---|
| `bun test` | unit and policy tests | **yes** |
| `bun run test:e2e` | tests that spawn real processes | no |

`bun test` must pass in **any** environment, including one that forbids process
creation. A test that needs to spawn a process is declared with `e2e(...)` from
`tests/helpers.ts`:

```ts
import { e2e } from "./helpers";

e2e("runs an allowed command and captures stdout", async () => {
  const res = await svc.run({ argv: ["bun", "--version"] });
  expect(res.code).toBe(0);
});
```

The default run skips it with a message naming the command that executes it.

**Never convert a skip into a pass.** A skipped suite that is mistaken for a
green one hides real defects — that is exactly how two Windows bugs (batch-file
command shims rejecting metacharacter arguments, and a probe reporting absent
toolchains as available) reached a commit. If you cannot verify something, say
so in the pull request.

---

## Development workflow

Weber uses test-driven development, and the commit history is the record:

1. **Red** — commit the failing tests as `[WIP] test: ...`
2. **Green** — commit the implementation as `feat(...)`/`fix(...)`

Write the test first, watch it fail for the reason you expect, then implement.
A test that has never failed has not been shown to test anything.

### Commit messages

Explain **why**, not what. The diff already shows what changed. When you fix a
bug, state what the previous code did wrong and what the observable symptom
was.

Good:

```
fix(exec): run native executables, not Windows shell shims

On Windows `bun` on PATH is bun.cmd (a batch file), and spawning it routes
through cmd.exe, which rejects arguments containing metacharacters. A command
like `bun -e 'a;b'` therefore failed with EINVAL even though it was
allow-listed and safe.
```

Bad: `fix bug`, `update exec.ts`.

---

## Non-negotiable invariants

These are enforced by tests, and a change that breaks one needs a very good
argument:

1. **`web` is the only published service.** The core declares `expose`, never
   `ports`. Requests reach it through the edge.
2. **Paths are rejected, not sanitised.** `resolveInRoot` throws on traversal,
   absolute, UNC or NUL-bearing input. Do not "helpfully" clean such a path.
3. **Nothing is ever run through a shell.** `argv` is an array, spawned with
   `shell: false`. A shell would defeat both the allow-list and the guarantee
   that arguments are data.
4. **A binary must be a bare, allow-listed name.** Paths are refused, so an
   unvetted binary cannot be reached by absolute path.
5. **`.env` is never committed.** Use `.env.example` templates for anything
   that must be shared.

---

## Adding a language toolchain

1. Add an entry to `TOOLCHAINS` in `src/core/exec.ts`, and add its binaries to
   `ALLOWED_BINARIES`. Widening the allow-list widens the attack surface, so
   justify it in the pull request.
2. Extend the toolchain registry test.
3. If it needs an LSP, that is a separate change — see `docs/ISSUES.md`.

---

## Reporting bugs and proposing changes

GitHub issues could not be filed programmatically when the project was
bootstrapped, so the open items live in **[docs/ISSUES.md](docs/ISSUES.md)**,
written to be filed verbatim.

- **Unsettled design decisions** are in
  **[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)**.
- **What actually works** — and what does not — is in
  **[docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)**. Please keep it current;
  an out-of-date status document is worse than none.

---

## License

Weber is AGPL-3.0. By contributing you agree your work is licensed under the
same terms. If you run a modified Weber as a network service, you must make the
source available to your users.
