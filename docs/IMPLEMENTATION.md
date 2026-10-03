# Implementation status

An honest account of what exists, what is verified, and what does not exist
yet. The README describes the destination; this file describes where we
actually are.

Last updated alongside the `feat(core)` commits.

## Verified working

Everything below has tests that run in the default `bun test` pass.

| Area | Module | Tests |
|---|---|---|
| Container topology + nginx routing | `podman-compose.yml`, `compose/` | 13 |
| Path sandbox | `src/core/paths.ts` | 11 |
| File service | `src/core/files.ts` | 20 |
| Reactive notebook engine | `src/core/notebook/` | 21 |
| Exec policy (allow-list, cwd, argv) | `src/core/exec.ts` | 12 |
| Config validation | `scripts/validate-config.ts` | 15 checks |

```
bun test          78 pass, 7 skip, 0 fail
bun run test:e2e  19 pass, 0 fail
```

## Implemented and verified, but only outside a restricted sandbox

`src/core/exec.ts` spawns real processes. Its **policy** (allow-list, bare-name
rule, NUL rejection, cwd confinement) is unit-tested and hermetic, so it runs in
the default suite.

Its **behaviour** (exit codes, stderr separation, timeouts, shell-immunity,
toolchain probing) is covered by tests declared with `e2e(...)`, which need a
child process with piped stdio. Those tests are skipped by default and run via
`bun run test:e2e`. They pass — but only where process spawning is permitted,
so a run that skips them proves less than a run that executes them.

Running them is what caught two genuine Windows defects that a restricted
environment had hidden: bare command names resolving to `cmd.exe`/`sh` shims
(which reject metacharacter arguments and so broke safe commands), and
`probe()` reporting absent toolchains as available. Both are fixed; see commit
`fix(exec): run native executables, not Windows shell shims`.

The lesson is recorded deliberately: **an environment limitation can mask a
real bug, so a skipped suite must never be read as a passing one.**

## Not implemented yet

These are named in the README and do not exist in code:

- **HTTP API surface** (`/api/fs/*`, `/api/tools/*`, `/api/notebook/*`) and the
  WebSocket terminal. The services they would call are complete and tested;
  the transport layer is not written.
- **`compose/Dockerfile.core`** and the `core` image. The compose file
  references it; the file does not exist yet.
- **Frontend.** No SPA, no Monaco, no Project/Script mode UI. `build:web`
  is declared but has no implementation, so `Dockerfile.web` cannot build yet.
  The compose topology is correct and lint-validated; it is not yet runnable
  end to end.
- **LSP integration** (clangd, rust-analyzer, tsserver proxying).
- **Pyodide** Python execution in the browser.
- **VS Code extension host.**
- **AI completion.**
- **Collaborative editing**, offline mode, mobile layout.

## Deliberate design decisions worth review

1. **`values` is keyed by binding name, not cell id.** A notebook's unit of
   meaning is the name a reader types. This makes `values.get("c")` work for
   `const c = b + 1`, at the cost of last-writer-wins when two cells define the
   same name.

2. **Parsing is a token scan, not a full JS parse.** Correct for realistic
   cells, and avoids a large dependency. Known limits: unusual ASI-heavy
   constructs, `with` blocks, and bindings introduced only through `eval` are
   not modelled. A real parser (or Bun's transpiler AST) should replace this if
   cells grow complex.

3. **Cell evaluation uses `new Function`, not a VM or worker.** Cells are the
   user's own code in the user's own workspace, so this is the product rather
   than a hole in it — but it does mean a notebook cell has the same privileges
   as the core process. `WEBER_SANDBOX` is reserved as the flag that will move
   evaluation into isolation; **it is currently unused and enforces nothing.**

4. **`core` mounts the repository read-only at `/opt/weber`.** Convenient for
   development; should be dropped from a production compose profile.

5. **The exec allow-list is a `Set` in source.** Deliberately small and
   reviewable. It will need to become configuration before it can cover a real
   polyglot toolchain.

## Suggested next steps

In dependency order:

1. `compose/Dockerfile.core` + `/api/health`, so the stack boots.
2. HTTP file/tool routes, so Project Mode has a backend.
3. Minimal SPA + `scripts/build-web.ts`, so `Dockerfile.web` builds.
4. WebSocket terminal on top of the existing `ExecService`.
5. Notebook routes + Script Mode UI on top of the existing engine.
