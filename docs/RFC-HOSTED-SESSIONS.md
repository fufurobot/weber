# RFC: Hosted sessions (Binder-style) vs WASM toolchains

**Status:** proposed — this document exists to force a decision before code
**Supersedes:** the deployment assumptions in `docs/RFC-MULTIUSER.md`
**Related:** issue #2, `docs/OPEN-QUESTIONS.md` §1

---

## Why this document exists

Three requirements were raised together that cannot all hold at once:

1. **Binder-style hosted sessions** — launch from a repo URL, ephemeral,
   any GitHub account, rate-limited
2. **Statically servable** — "compile rustc, bun and clang/clangd to WASM,
   ship with Pyodide, serve as static files"
3. **HPC remote IDEs** — Singularity/AppImage on clusters

Requirement 2 is incompatible with 1 and 3. That is not a matter of effort; it
is a property of what each runtime needs. Spending weeks discovering this would
be expensive, so it is written down first.

---

## The core conflict

Weber's value proposition is **an IDE with a real shell**: `cargo build`,
`clang -o out main.c`, `bun test`. Every one of those is a native process with
a real filesystem, real threads and real networking.

Moving the toolchain into the browser does not make that shell faster or
safer — **it removes the shell.** A WASM `rustc` has no `~/.cargo`, no
crates.io access, no linker against system libraries, and no subprocesses.

So requirement 2 describes a different product: a **compiler playground**, not
an IDE. That product is legitimate and much cheaper to host, but it is not the
thing in the README.

---

## What each requirement actually needs

| Requirement | Needs | Hosting |
|---|---|---|
| **1. Ephemeral repo sessions** | Per-session sandbox, TTL reaper, build recipe | A container host (Heroku/Render/Fly). Ephemeral disk is a *feature*. |
| **2. Static + WASM toolchains** | `rustc`/`bun`/`clangd` as WASM | **Any static host.** No server at all. |
| **3. HPC remote IDEs** | Server-side compute, cluster filesystem | Singularity/AppImage on the cluster, browser as a thin client. |

Note that 1 and 3 share an architecture (**server-side compute, browser
frontend**) and 2 is alone. That is the real choice: 2 is not a variant of 1
and 3, it is an alternative to them.

---

## Per-toolchain reality check

Recorded as claims to be verified rather than assumed; see the research
summary referenced in the decision log.

| Toolchain | WASM in browser? | Why |
|---|---|---|
| **Pyodide (Python)** | **Yes, works today** | Genuine WASM CPython, mature. This one is not in doubt. |
| **TypeScript** | Partly — esbuild-wasm, SWC, tsgo transpile | But **Bun cannot be compiled to WASM** (it wraps JavaScriptCore). The README's "Bun runtime" claim does not survive the move. |
| **Rust** | `rustc` compiles to WASM only for restricted targets | No `.cargo`, no crates.io, no proc macros. Real `cargo build` is server-side. |
| **C/C++** | clang→WASM can compile simple files | **clangd cannot run in a browser** — it needs a real FS, threads and process spawning. Every browser IDE ships LSP *server-side* for this reason. |
| **clangd (LSP)** | **No** | This is why vscode.dev delegates language servers to a remote or WASM-shim with reduced features. |

The pattern: **the editor can be static; the language intelligence cannot.**

---

## How existing products actually do it

This is the most useful evidence, and it is consistent:

| Product | Toolchain runs where |
|---|---|
| **Binder / JupyterHub** | Server-side container per session |
| **Google Colab** | Server-side VM |
| **GitHub Codespaces** | Server-side container |
| **Gitpod** | Server-side container |
| **vscode.dev** | Editor in browser; **language servers delegated** or WASM-limited |
| **StackBlitz WebContainers** | Node.js WASM in-browser — but Node + npm only, not arbitrary native binaries |

Nobody runs a general native toolchain in the browser, because
`gcc`/`cargo`/`clangd` are not browser-shaped programs. Where a browser IDE
appears to compile C++, either the compile is server-side or the subset is
tiny.

**The implication for Weber:** the frontier of what is genuinely achievable
in-browser is Pyodide plus a JS/TS transpiler. Everything else in the README's
language list needs a server.

---

## Options

### Option A — Hosted sessions (Binder-style), server-side toolchains

Launch from a repo URL; per-session workspace; TTL reaper; any GitHub account
with rate limits.

- **Buys:** the actual product. Real `cargo build`, real clang, real shell.
- **Costs:** a container host; you are running strangers' code; needs the
  isolation work in `RFC-MULTIUSER.md`.
- **Honest risk:** on Heroku specifically, dynos cannot nest containers, so
  per-session isolation must be **process-level, not kernel-level** — weaker
  than Binder. Users share a dyno. That is a real reduction in safety, and it
  should be stated to users rather than hidden.

### Option B — Static WASM playground, no server

Pyodide + a TS transpiler, everything client-side, deployed to Pages.

- **Buys:** genuinely free, genuinely safe (no server executes anything), and
  it fits the existing Pages deployment.
- **Costs:** no Rust, no C/C++, no shell, no `cargo`. The README's promise
  shrinks to "Python and TypeScript scratchpad".
- **Note:** this is largely what the Pages demo already is, but with real
  Pyodide instead of a mock. That is a meaningful upgrade and a small job.

### Option C — HPC/remote, thin browser client

Weber as a frontend to a cluster you already have access to (Singularity
image), no hosting problem at all.

- **Buys:** real compute, real filesystem, no abuse surface — it is your
  cluster account.
- **Costs:** only useful to people who already have cluster access. Not a
  public service.

---

## Recommendation

**Build B and C; do not build A yet.**

Reasoning:

1. **Option B is small and safe**, and it upgrades the demo from fixtures to a
   real Python runtime. It is deployable this week.
2. **Option C is the best fit for the stated purpose.** "HPC remote IDEs" is
   the actual use case, and it needs no public abuse surface at all. A
   Singularity/AppImage Weber that talks to a cluster gives you real
   toolchains with zero hosting risk.
3. **Option A is the expensive one**, and it is the one that would need the
   isolation work to be trustworthy. It also cannot be done safely on Heroku
   for the reason above — so if it is ever built, it wants a host that can nest
   containers (a small VM), which is exactly what you said you do not have.

The uncomfortable summary: **Heroku gives you a public URL, but not the
isolation that makes a public URL safe for a tool that runs arbitrary code.**
It is a good host for option B or for a private single-user instance, and a
poor host for option A.

---

## What I would do next, concretely

1. **Ship Pyodide in Script Mode** — real Python in the browser, replacing the
   server-side Python path for the notebook. Small, safe, immediate.
2. **Keep the server-side notebook** for projects that need real toolchains.
3. **Add a Singularity/AppImage build** for the HPC case, with the browser as a
   thin client over SSH or a local port.
4. **Only then** decide about public multi-user, with the isolation work from
   `RFC-MULTIUSER.md` as a prerequisite rather than an afterthought.

Each step is independently useful, and none of them requires solving the
hardest problem first.

---

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| — | Split the RFC out | The three requirements were being treated as one project |
| — | Recommended B + C over A | A is the expensive path and cannot be made safe on the stated host |
