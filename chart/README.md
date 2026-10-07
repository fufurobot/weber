# Weber Helm chart

Deploys Weber — a polyglot IDE — as a thin gateway in front of the services
that do the work.

```
                       ┌──────────────────────────────┐
   ingress ──────────▶ │  gateway  (nginx + SPA)      │
                       │  /api  /ws                   │
                       │  /gitlab  /judge0  /dsh      │
                       └───────────────┬──────────────┘
                                       │  in-cluster only
        ┌──────────────┬───────────────┼──────────────┬──────────────┐
        ▼              ▼               ▼              ▼              ▼
   weber-core      judge0          gitlab           dsh        (ml-hub
   Bun API,        sandboxed       projects +      agentic     services
   terminal,       snippets        CI              coding      via gateway)
   notebooks
```

Everything is reached through **one origin**, which is not cosmetic: it avoids
CORS entirely, and one TLS certificate covers every service.

---

## Install

```bash
helm install weber ./chart \
  --namespace weber --create-namespace
```

That gives you a private instance: the gateway is a `ClusterIP` and no ingress
is created. Reach it with a port-forward:

```bash
kubectl port-forward -n weber svc/weber-weber-gateway 8080:80
# open http://localhost:8080
```

## Exposing it publicly

**Authentication is mandatory before exposure, and the chart enforces it.**
Weber executes user-supplied code, so installing with `ingress.enabled=true`
and `auth.enabled=false` **fails at render time** rather than deploying an open
shell:

```
Error: refusing to install: ingress.enabled requires auth.enabled.
```

GitHub sign-in uses the **device flow**, which needs only a client ID — there is
no client secret to store. Create an OAuth app at
<https://github.com/settings/developers> with **Enable Device Flow** ticked, then:

```bash
helm install weber ./chart \
  --set ingress.enabled=true \
  --set auth.enabled=true \
  --set auth.githubClientId=Iv1.xxxxxxxx \
  --set auth.allowedLogins=yourusername \
  --set auth.existingSecret=weber-auth     # recommended, see below
```

`auth.allowedLogins` is a comma-separated list. It defaults to empty, and an
empty list **denies everyone** — which is why the chart refuses to install with
auth enabled and no allow-list, rather than leaving you with a service nobody
can enter.

### Supply your own session secret

Without `auth.existingSecret`, the chart generates one and annotates it
`helm.sh/resource-policy: keep`. That is safe across upgrades, but a generated
secret you cannot see is awkward to rotate or to share across replicas. In
production create it yourself:

```bash
kubectl create secret generic weber-auth \
  --from-literal=session-secret="$(head -c 32 /dev/urandom | base64)"
```

---

## Components

| Component | Default | Why that default |
|---|---|---|
| `gateway` | **on** | The only thing that should ever be exposed. |
| `core` | **on** | Weber itself: files, terminal, notebooks. |
| `judge0` | on | Sandboxed snippets, so untrusted code never reaches the core's shell. Needs Postgres and Redis; point it at yours via `judge0.postgres.host` and `judge0.redis.host`. |
| `gitlab` | **off** | Heavy (several GiB). Most clusters already have one — set `gitlab.enabled=true`, or leave it off and use your own. |
| `dsh` | **off** | Agentic programming. Requires an API key via `dsh.existingSecret`. |
| `ingress` | **off** | Exposing a service that runs user code should be deliberate. |
| `networkPolicy` | **on** | Default-deny, with only the gateway able to reach the core. |

### ml-hub-style services

Services behind the gateway follow the ml-hub pattern: one host, one
certificate, path-based routing. To add one, extend the `upstream` and
`location` blocks in `templates/gateway-configmap.yaml` — the existing
`/gitlab`, `/judge0` and `/dsh` entries are the template to copy.

---

## Why the guarantees are where they are

**The core is `ClusterIP` and nothing else.** It runs user code; it must not be
reachable except through the gateway.

**The chart fails on an unsafe configuration.** A chart that deploys an open
shell with a warning in the README has not actually prevented anything.

**Resource limits are mandatory**, on the pod *and* per user
(`workspaceLimits`). The Kubernetes limits cap the pod; the application limits
cap an individual user inside it. Without the second, one user exhausts the
pod and takes everyone with them.

**The gateway config lives in a ConfigMap with a checksum annotation on the
Deployment.** Without the checksum, editing the config does nothing until
someone restarts pods by hand — a genuinely confusing failure.

---

## Secrets

Nothing is inlined. Credentials are read from `auth.existingSecret`,
`judge0.existingSecret` and `dsh.existingSecret`; the only generated value is
the session secret. A test asserts no template contains a literal credential.

---

## Testing without a cluster

The same images serve both runtimes, so the compose path exercises the same
artifacts:

```bash
podman-compose up --build      # nginx edge + Bun core on :3000
```

To check the chart renders without installing:

```bash
helm template weber ./chart > /dev/null          # fails on a bad config
helm template weber ./chart --set ingress.enabled=true   # must fail: no auth
```

The second command **should** fail. If it succeeds, the safety check has
regressed.

---

## Limitations, stated plainly

- **No database is managed.** Judge0 and GitLab need Postgres and Redis; point
  them at existing instances. This chart does not pretend to run a database.
- **The core is single-replica** because the workspace volume is
  `ReadWriteOnce`. Scaling it out needs a `ReadWriteMany` class and is not
  tested.
- **`securityContext.readOnlyRootFilesystem` is `false`** by default. Turning
  it on needs writable volumes for the toolchains, which this chart does not
  yet wire up.
- **The toolchain image is referenced but not built here.** `weber-toolchains`
  is expected to exist in your registry; the core image ships Bun only.
- **Per-user isolation is not implemented.** All users share one process and
  one workspace root. See `docs/RFC-MULTIUSER.md` — that is a prerequisite for
  genuinely public multi-user hosting, not a configuration flag.
