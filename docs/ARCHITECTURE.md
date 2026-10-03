# Architecture

Weber is two containers and one network. This document explains what each part
owns, and why the boundaries sit where they do.

```
                    ┌─────────────────────────────────────────┐
   browser ────────▶│  web  (nginx:1.27-alpine)               │
   host :3000       │  · serves the SPA                       │
                    │  · /api/*  → core                       │
                    │  · /ws     → core (websocket upgrade)   │
                    │  · /healthz                             │
                    └───────────────────┬─────────────────────┘
                                        │  weber-net (internal bridge)
                    ┌───────────────────▼─────────────────────┐
                    │  core  (oven/bun:1.3-alpine)            │
                    │  · /api/health, /api/fs/*, /api/tools/* │
                    │  · /ws terminal + notebook events       │
                    │  · path sandbox · exec allow-list       │
                    │  · reactive notebook engine             │
                    └───────────────────┬─────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ weber-workspaces  │  named volume
                              │ /workspaces       │  (user projects)
                              └───────────────────┘
```

## Service boundaries

**`web` is the only published surface.** It owns TLS termination, static
assets and the SPA history fallback. The core service declares `expose` rather
than `ports`, so it is unreachable from the host even by accident; every
request reaches it through the edge. This mirrors how the system would be
deployed behind a real ingress and means the security posture does not change
between `podman-compose up` and production.

**`core` owns everything privileged.** Filesystem access, process execution and
notebook evaluation all live here, behind two chokepoints:

- `src/core/paths.ts` — every path from the browser is resolved here. It
  *rejects* traversal, absolute and NUL-bearing input instead of sanitising it,
  because a request that tries to escape is a bug or an attack, and both
  deserve a loud failure.
- `src/core/exec.ts` — the binary allow-list and the argv-as-array rule. No
  shell is ever involved, so metacharacters are data.

Both chokepoints are pure functions with direct unit tests, which is why the
policy can be trusted without standing up the whole stack.

## Why nginx in front of Bun

Bun could serve the SPA itself. Splitting them anyway buys three things:

1. **The publish boundary is explicit.** One `ports:` entry in the whole
   compose file, on the service that has no filesystem or exec access.
2. **Static assets are served by the tool that is best at it**, with
   immutable caching for hashed assets and `no-store` for the shell.
3. **Websocket proxying is a configuration concern**, not application code:
   the `$connection_upgrade` map means `Connection: upgrade` is only sent when
   the client actually asked for an upgrade.

## The reactive notebook

Script Mode is not a re-evaluating notebook; it is a dependency graph.

The graph is **derived from source** (`src/core/notebook/parse.ts`), not
declared. A cell's top-level bindings are its exports; its free identifiers
that match another cell's exports become edges. This means users write ordinary
code — `const b = a * 3` — and get reactivity for free, which is the property
that makes Observable and Marimo feel different from Jupyter.

`src/core/notebook/engine.ts` then guarantees:

- **Topological execution**, independent of the order cells appear on screen.
- **Minimal recomputation.** Dirty tracking means editing one cell re-runs only
  that cell and its transitive dependents; unrelated cells keep their run count.
- **Failure containment.** A failing cell taints its dependents, which are
  *skipped* rather than executed against stale or missing bindings; the failed
  cell's stale exports are retracted so nothing downstream believes them.
- **Cycle detection** reported as an error instead of a hang.

Parsing is a scope-aware token scan rather than a full JS parse. That is a
deliberate trade: cells are small snippets, and a full parser is a large
dependency for a case the scan already handles for realistic cells. The limits
of that choice are noted in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Testing strategy

Two suites, split by what the environment permits:

| Command | Contents | Hermetic |
|---|---|---|
| `bun test` | path sandbox, file service, notebook engine, exec **policy** | yes |
| `bun run test:e2e` | everything that spawns a real process | no |

The split exists because a sandbox that forbids `spawn` with piped stdio would
otherwise report an environment limitation as a product failure. Tests needing
a real process are declared with `e2e(...)` from `tests/helpers.ts`, so the
default run **skips** them with a message naming the command that runs them —
a skip is honest, a false pass is not.
