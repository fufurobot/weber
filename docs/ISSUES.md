# Issues and follow-ups

GitHub issues could not be filed programmatically: the API token available in
`.env` is read-only. Creating an issue and creating a pull request both return:

```
403 Resource not accessible by personal access token
```

Git push works (over SSH), so the code and this record are public — but the
triage surface is not. These are the items that would have been filed, written
so they can be copied into GitHub verbatim, or resolved directly.

To file them for real, create a token with **Issues: write** and
**Pull requests: write** on this repository, then run `scripts/file-issues.ts`
(not yet written) or paste them by hand.

---

## P1 — `WEBER_SANDBOX` is declared but enforces nothing

**Labels:** `security`, `bug`, `good first issue`

`podman-compose.yml` passes `WEBER_SANDBOX` to the core service, and
`compose/.env.example` documents it as "1 = execute notebook/terminal cells in
a restricted sandbox". Nothing reads the variable.

`NotebookEngine.execute` evaluates cells with `new Function`, so a cell runs
with the full privileges of the core process: it can read the workspace and do
anything a reachable import allows.

**Why it matters.** For a single-user self-hosted instance this matches the
trust model of running a script locally. Weber is explicitly deployable as a
network service (AGPL §13 anticipates this), and the moment one instance is
shared, "the user's own code" stops being true. An environment variable that
*looks* like a security control but is inert is worse than no variable at all,
because it invites a false sense of safety.

**Acceptance criteria.**

- [ ] Either implement isolation (subprocess per run, reusing the `ExecService`
      allow-list machinery) or remove the variable and correct the docs.
- [ ] If implemented, exported values must cross a process boundary, so decide
      explicitly what a cell may return.
- [ ] A test that a cell cannot read outside the workspace when the flag is on.

**Blocked by:** nothing. **Related:** `docs/OPEN-QUESTIONS.md` §1.

---

## P1 — Container images have never been built

**Labels:** `build`, `needs-verification`

`compose/Dockerfile.core` and `compose/Dockerfile.web` are validated by
inspection and config assertions only. No container runtime was available where
they were written (the Podman VM would not start), so `podman-compose up` has
never run.

Every input is pinned by a test — build stages, non-root user, `EXPOSE`,
healthchecks, and that each `COPY` target exists — but "the tests pass" is a
different claim from "the image builds".

**Acceptance criteria.**

- [ ] `podman-compose up --build` completes on a machine with a runtime.
- [ ] Both healthchecks report healthy.
- [ ] `curl localhost:3000/api/health` returns ok **through the edge**.
- [ ] The SPA loads at `http://localhost:3000/`.
- [ ] Add a CI job that builds both images, so this stays verified.

**Blocked by:** a machine with a working container runtime.

---

## P2 — The editor is a textarea; there is no Monaco or LSP

**Labels:** `frontend`, `enhancement`

`web/main.ts` renders a plain `<textarea>`. There is no syntax highlighting, no
completion, and no language intelligence. The README promises Monaco and LSP
support for TypeScript, Rust and C++.

**Acceptance criteria.**

- [ ] Monaco loaded from the edge as a static asset (the SPA builds inside a
      Bun-only image, so bundling it has a cost worth measuring first).
- [ ] An LSP proxy in the core for at least `clangd`, sharing the `ExecService`
      allow-list rather than spawning binaries directly.
- [ ] Graceful degradation when a language server is absent.

---

## P2 — `parseCell` is a token scan, not a parser

**Labels:** `notebook`, `tech-debt`

The dependency scanner is correct for realistic JavaScript cells and avoids a
large dependency, but its blind spots are unhandled: automatic semicolon
insertion in unusual positions, `with` blocks, `eval`-introduced bindings,
TypeScript annotations parsed as values, and JSX.

The JSX and TypeScript gaps matter because the README promises both.

**Acceptance criteria.**

- [ ] Either replace the scanner with Bun's transpiler AST, or document the
      supported subset in the UI itself.
- [ ] Add tests for whichever constructs remain supported.

**Related:** `docs/OPEN-QUESTIONS.md` §2.

---

## P2 — The exec allow-list is a Set in source

**Labels:** `core`, `enhancement`

`ALLOWED_BINARIES` in `src/core/exec.ts` is a fixed list. It cannot cover a real
polyglot toolchain (`zig`, `go`, `deno`, `make`, `cmake`, `pkg-config`, ...) and
must be edited to add a language.

**Acceptance criteria.**

- [ ] Move to configuration with a documented, reviewable default.
- [ ] Preserve the bare-name invariant (a binary must not be a path).
- [ ] Document that widening the list widens the attack surface.

**Related:** `docs/OPEN-QUESTIONS.md` §4.

---

## P3 — Binding-name collisions are silent

**Labels:** `notebook`, `ux`

`NotebookEngine.values` is keyed by binding name, so when two cells define the
same name the later one wins with no diagnostic. A user editing a cell they
forgot duplicates will see a value change with no explanation.

**Acceptance criteria.**

- [ ] Surface a warning in Script Mode naming both cells.
- [ ] Do **not** reject the duplicate outright: redefining a name while
      iterating on a cell is legitimate.

**Related:** `docs/OPEN-QUESTIONS.md` §3.

---

## P3 — The workspace is empty on first run

**Labels:** `ux`, `good first issue`

`findProjectRoots` discovers projects by marker file, but nothing seeds the
workspace volume. A first-time user opens an empty IDE with no indication of
what to do next.

**Acceptance criteria.**

- [ ] On first boot with an empty volume, seed a small example: one TypeScript
      file, one Rust file, one notebook.
- [ ] Point Project Mode at it.
- [ ] Make it removable, and never overwrite an existing workspace.

**Related:** `docs/OPEN-QUESTIONS.md` §6.

---

## P3 — The SPA has never been opened in a browser

**Labels:** `frontend`, `needs-verification`

The built SPA was served through a simulation of the edge and fetched over
HTTP, which proves the routes, hashed asset names and MIME types resolve. It
does not prove the UI renders or that interactions work.

**Acceptance criteria.**

- [ ] Load it in a real browser and click through both modes.
- [ ] Add a browser-driven smoke test (Playwright or similar) to CI.

---

## P4 — Python cells run server-side, not in Pyodide

**Labels:** `python`, `enhancement`

The README promises Pyodide (Python in the browser via WebAssembly). Python
currently runs only through `ExecService` against the server's CPython, which
means Python cells need a server and share its trust boundary.

**Acceptance criteria.**

- [ ] Load Pyodide in the browser for Script Mode.
- [ ] Keep server-side CPython for build tasks, where it is the right tool.
- [ ] Make the difference visible, since the two have different capabilities.
