# Open questions and design notes

A public record of the decisions that are not yet settled, and the reasoning
behind the ones that are. This file exists so the thinking is reviewable
alongside the code rather than buried in commit messages.

Everything here is fair game for review. Items marked **open** need a decision
before the next milestone.

---

## 1. Cell evaluation currently shares the core process's privileges — **open**

`NotebookEngine.execute` evaluates cells with `new Function`. A cell therefore
has the same authority as the core service: it can read the workspace and, via
any reachable import, do anything the process can.

**Why it is like this.** Cells are the user's own code in the user's own
workspace. In a single-user, self-hosted IDE that is the product, not a hole in
it — the same trust model as running a script locally.

**Why it is still a problem.** Weber is deployable as a network service
(AGPL §13 explicitly anticipates this). The moment two people share one
instance, "the user's own code" stops being true. The `WEBER_SANDBOX`
environment variable is declared in compose and **currently enforces nothing**;
shipping it as if it did would be worse than not having it.

**Options.**

| Option | Isolation | Cost |
|---|---|---|
| Worker thread | None (same heap, shared `process`) | Trivial |
| `node:vm` context | Weak — escapes are well documented | Low |
| Separate subprocess per run | Good | Process spawn per cell, serialization of bindings |
| Bun's `Worker` + restricted globals | Moderate | Bindings must be structured-cloneable |

**Recommendation:** a subprocess per notebook run, reusing the `ExecService`
allow-list machinery. It fits the existing architecture, gives real isolation,
and forces an explicit decision about what a cell may return. The blocker is
that exported values must become serializable, which would break cells that
currently return functions or class instances.

---

## 2. The reference scanner is a token scan, not a parser — **accepted risk**

`parseCell` reasons about scope with a hand-written scanner. It correctly
handles the realistic cases (nested scopes, destructuring, property names,
strings/comments/regex), and avoids pulling a full JS parser into the critical
path.

**Known blind spots**, none of which are covered by tests:

- automatic semicolon insertion in unusual positions,
- `with` blocks,
- bindings introduced only via `eval`,
- TypeScript type annotations parsed as values,
- JSX, which Weber's README explicitly promises to support.

**Recommendation:** before Script Mode shows TS/JSX in the UI, replace this with
Bun's own transpiler output or a real parser. The token scanner should be
treated as a placeholder that happens to be correct for simple JS.

---

## 3. `values` is keyed by binding name, which makes collisions silent — **open**

`engine.values` maps `"c"` → the value of `const c = ...`. This is what makes
`values.get("c")` read naturally, but when two cells define the same name the
later one wins with no diagnostic.

**Options:** (a) keep last-writer-wins and surface a warning in the UI,
(b) reject duplicate bindings at `setCells` time, (c) namespace by cell and
provide a resolver.

**Recommendation:** (a) plus a UI badge. Rejecting outright would make
iterating on a cell (where you legitimately redefine a name) painful.

---

## 4. The exec allow-list is a Set in source — **open**

`ALLOWED_BINARIES` is deliberately small and reviewable. It cannot cover a real
polyglot toolchain (`zig`, `go`, `deno`, `make`, `cmake`, `pkg-config`, ...).

**Recommendation:** move to configuration with a documented default, and keep
the invariant that a binary must be a bare name. Do this *before* adding more
languages, so the policy stays reviewable as it grows.

---

## 5. Windows shims versus argv-as-data — **resolved, worth remembering**

Bare names on Windows often resolve to `bun.cmd` (batch) or an extensionless
`bun` that is a `/bin/sh` script. Spawning either routes the call through
`cmd.exe`/`sh`, which rejects arguments containing metacharacters — so safe,
allow-listed commands failed with `EINVAL`.

Resolved by resolving only genuine native executables and reporting a shim as
exit 126 rather than silently using a shell.

**The lesson is the interesting part:** this defect was invisible in a
restricted environment, because the tests that would have caught it could not
spawn a process at all. They were **skipped**, not passing — and a skipped
suite that is mistaken for a green one hides exactly this class of bug. The
project now keeps those tests in a separate `test:e2e` target so the skip is
explicit and never reads as success.

---

## 6. The starter workspace is empty — **open**

`findProjectRoots` discovers projects by marker files, but nothing seeds the
workspace volume. A first-time user opens an empty IDE with no indication of
what to do.

**Recommendation:** seed a small example project (one TS file, one Rust file,
one notebook) on first boot when the volume is empty, and point Project Mode at
it.
