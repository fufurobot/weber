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
| HTTP API | `src/server/app.ts` | 30 |
| Terminal protocol | `src/server/terminal.ts` | 11 |
| Core image contract | `compose/Dockerfile.core` | 11 |
| Config validation | `scripts/validate-config.ts` | 24 checks |

```
bun test          130 pass, 7 skip, 0 fail
bun run test:e2e   19 pass, 0 fail
```

Verified against a **running server**, not only in unit tests: `/api/health`,
file write and read, notebook reactivity (`b = a * 21` → `42`), a policy
refusal, and a full websocket session (ready → refusal without a start frame →
streaming → exit).

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

- **Frontend.** No SPA, no Monaco, no Project/Script mode UI. `build:web` is
  declared but has no implementation, so `compose/Dockerfile.web` cannot build
  yet. The edge topology is correct and lint-validated, but the stack is not
  runnable end to end until this exists.
- **LSP integration** (clangd, rust-analyzer, tsserver proxying).
- **Pyodide** Python execution in the browser.
- **VS Code extension host.**
- **AI completion.**
- **Collaborative editing**, offline mode, mobile layout.

## Known limitation of the terminal

`/ws` is a **policy-checked command channel, not a pty**. There is no
interactive shell, no job control, and no TTY-style echo. It runs allow-listed,
argv-shaped commands and streams their output.

This is deliberate. A real pty needs a shell, and a shell would bypass both the
binary allow-list and the argv-as-data guarantee that the rest of the system
depends on. A true interactive terminal is a separate design problem (it needs
its own isolation story) and is not attempted here.

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

1. ~~`compose/Dockerfile.core` + `/api/health`~~ — **done**.
2. ~~HTTP file/tool routes~~ — **done**.
3. ~~WebSocket terminal~~ — **done** (as a policy-checked command channel).
4. Minimal SPA + `scripts/build-web.ts`, so `Dockerfile.web` builds and the
   stack becomes runnable end to end.
5. Script Mode UI on top of the existing notebook engine.
6. LSP proxy and Pyodide.
