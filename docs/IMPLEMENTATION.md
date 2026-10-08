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
| Web build + SPA shell | `web/`, `scripts/build-web.ts` | 15 |
| Starter workspace seeding | `src/core/seed.ts` | 12 |
| Issue filing tooling | `scripts/file-issues.ts` | 7 |
| Helm chart and hardening | `chart/` | 55 |
| Pyodide kernel (browser) | `web/kernel/python.ts` | 20 |
| TypeScript kernel (browser) | `web/kernel/typescript.ts` | 19 |
| Browser notebook | `web/notebook-browser.ts` | 14 |
| Python backend selection | `src/core/python.ts` | 10 |
| Per-user limits | `src/core/limits.ts` | 26 |
| Workspace tenancy | `src/core/tenancy.ts` | 15 |
| GitHub OAuth | `src/server/auth.ts` | 16 |
| Config validation | `scripts/validate-config.ts` | 51 checks |

```
bun test          377 pass, 7 skip, 0 fail
bun run test:e2e   19 pass, 0 fail
bun run typecheck  clean (blocking in CI)
```

Verified against a **running server**, not only in unit tests: `/api/health`,
file write and read, notebook reactivity (`b = a * 21` → `42`), a policy
refusal, a full websocket session (ready → refusal without a start frame →
streaming → exit), the built SPA served through an edge simulation that
mirrors the nginx config, and first-boot seeding including the no-clobber path
on restart.

The Helm chart is verified by **real `helm template` rendering in CI**, not by
reading the templates: the chart job lints, renders the defaults, proves that
an unauthenticated public install is *refused*, proves an empty allow-list is
refused, and proves a fully configured install still renders.

## Known limitations worth stating plainly

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

- **Monaco editor and LSP integration** (clangd, rust-analyzer, tsserver). The
  editor is currently a plain textarea, and there is no language intelligence.
- **VS Code extension host.**
- **AI completion.**
- **Collaborative editing**, offline mode, mobile layout.

## Deployment

Two targets, with different capabilities — worth keeping distinct:

| Target | What runs | Limitation |
|---|---|---|
| `podman-compose up` | the real product | needs a container runtime |
| GitHub Pages | the interface only | no backend; fixtures |

**GitHub Pages is a demo, not a deployment of the product.** File operations,
the toolchain runner and the notebook engine all live in the core service, and
Pages serves static files. So `scripts/build-pages.ts` aliases the API client
to `web/mock-api.ts` at bundle time and the shell shows a banner saying so. The
alias is done in the bundler rather than by forking the app, so the demo
exercises the same components the real build does.

**One manual step is required.** The workflow cannot enable Pages for itself —
its token returns `Resource not accessible by integration` when it tries. A
repository owner must set **Settings → Pages → Build and deployment → Source:
GitHub Actions** once. After that, `.github/workflows/pages.yml` deploys on
every push that touches the frontend.

The build step itself is verified: CI reports `pages artifact OK`, and the
artifact assertions check that `index.html`, `.nojekyll`, and hashed JS and CSS
assets all exist and that the shell references them.

- **The terminal is not a pty.** `/ws` is a policy-checked command channel: no
  interactive shell, no job control, no TTY echoing. A real pty needs a shell,
  and a shell would bypass both the binary allow-list and the argv-as-data
  guarantee the rest of the system depends on. That is a separate design
  problem, not an oversight.
- **`compose/Dockerfile.web` and `compose/Dockerfile.core` have never been
  built.** No container runtime was available in the environment where this was
  written (the Podman VM is not running), so the images are validated by
  inspection and config checks only. The build inputs, stages, healthchecks and
  the `build:web` contract are all pinned by tests, but "tests pass" is not the
  same claim as "the image builds".
- **The SPA has not been opened in a real browser.** Its output was served and
  fetched through a simulation of the edge, which proves the routes, asset
  naming and MIME types resolve — not that the UI renders correctly.
- **The frontend is dependency-free by design.** Monaco and a real component
  library are deferred rather than abandoned; the constraint was building
  inside a Bun-only image.

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
4. ~~Minimal SPA + `scripts/build-web.ts`~~ — **done**.
5. ~~Helm chart, tested against real `helm template` in CI~~ — **done**.
6. ~~Pyodide for in-browser Python, with a browser notebook~~ — **done**.
7. **Build the container images for real** on a machine with a runtime, and run
   `podman-compose up` end to end. Still the highest-value remaining step: it is
   the one claim resting on inspection rather than execution.
8. **v86 for Rust and C++ on Pages-only.** The only route to those toolchains
   with no server; see `docs/RFC-HOSTED-SESSIONS.md` Option D.
9. Monaco + LSP proxy, replacing the textarea editor.
10. **Kubernetes spawner** (a pod per user, the ml-hub model). This is what
    would make multi-user hosting genuinely isolated; see
    `docs/ML-HUB-ANALYSIS.md`.
