# ml-hub analysis and what to merge

**Source:** [ml-tooling/ml-hub](https://github.com/ml-tooling/ml-hub) at `master`
(chart at `helmchart/mlhub/`), read via the GitHub contents API.
**Purpose:** decide what of ml-hub belongs in our chart, and what does not.

---

## What ml-hub actually is

This is the finding that matters: **ml-hub is a JupyterHub distribution, not a
set of independent services.**

It is an explicit, simplified fork of
[Zero to JupyterHub K8s](https://github.com/jupyterhub/zero-to-jupyterhub-k8s).
Its own chart README says so:

> It is inspired and partially based on the great *Zero to JupyterHub K8s*
> project. However, we made some modifications...

The architecture is:

```
                    ┌──────────────────────────────┐
   ingress ───────▶ │  proxy  (configurable-http-proxy, "chp")  │
                    └───────────────┬──────────────┘
                                    │
                    ┌───────────────▼──────────────┐
                    │  hub  (JupyterHub +          │
                    │        KubeSpawner)          │
                    │                              │
                    │  CREATES A POD PER USER      │
                    └───────────────┬──────────────┘
                                    │ spawns on demand
                    ┌───────────────▼──────────────┐
                    │  singleuser pods             │
                    │  (ml-workspace images)       │
                    └──────────────────────────────┘
```

### Evidence for the spawner model

The hub's RBAC is decisive — it does not merely read resources, it **creates
and deletes them at runtime**:

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods", "persistentvolumeclaims"]
    verbs: ["get", "watch", "list", "create", "delete"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["list", "create", "delete"]
```

And the chart ships a custom spawner, `resources/mlhubspawner/` with
`mlhubkubernetesspawner.py` — a subclass of KubeSpawner, which is the
JupyterHub component that launches per-user pods.

---

## Correction to my earlier design

**My chart put the gateway in front of a fixed set of services. ml-hub puts a
gateway in front of a *spawner*.** These are different systems, and mine is
missing the central mechanism.

| | My chart (before) | ml-hub |
|---|---|---|
| Routing tier | nginx | configurable-http-proxy (`chp`) |
| Per-user isolation | **none** — one shared core pod | **a pod per user** |
| Workload creation | static, at install time | **dynamic, per user, at runtime** |
| Identity | OAuth in the app | JupyterHub `Authenticator` |
| User image | one `weber-core` | per-user `ml-workspace` |

That last row of the second column is the whole point: **ml-hub already solved
the isolation problem I wrote `RFC-MULTIUSER.md` about.** Each user gets their
own pod, so a runaway notebook cannot touch another user's files. I spent a
document designing per-user UIDs when the community answer is "spawn a pod".

I should have read this first. It is a better design than mine and it is
already built.

---

## What to merge, and what not to

### Merge — the spawner model

The per-user pod spawner is the correct isolation boundary for Kubernetes, and
it is strictly stronger than anything in my RFC:

- kernel-enforced (separate pods, separate namespaces)
- resource limits are per-pod, so one user cannot starve another
- a compromised user pod cannot reach another user's volume

**This replaces `RFC-MULTIUSER.md`'s subprocess/UID design** for the Kubernetes
path. That document remains correct for the *single-host* path (Heroku, a VM),
where pods are unavailable — which is exactly why it is still worth keeping.

### Merge — the chart conventions

ml-hub inherits several things from Zero-to-JupyterHub that our chart lacks:

| Convention | Why it matters |
|---|---|
| `schema.yaml` (19 KB!) | Validates values at install time, so a typo fails with a clear message rather than a nil-pointer deep in a template |
| `validate.py` | `helm lint` hook |
| `pdb.yaml` | PodDisruptionBudget, so a node drain does not take the hub down |
| `NOTES.txt` | Tells the operator what to do after install |
| `hub.db.type` | Switchable sqlite-pvc vs external database |
| `scheduling.podPriority` | `userPlaceholderPriority: -1`, so real user pods evict placeholders |
| `singleuser.cloudMetadata.enabled` | Blocks the cloud metadata endpoint — **an SSRF defence we do not have** |
| `extraEnv`/`extraVolumes`/`extraContainers` | The escape hatches every real chart needs |

Several of these are genuine security or reliability improvements over my
chart, not just polish.

### Merge — image-credentials secret

`hub/image-credentials-secret.yaml` handles private registries. We reference
images but give no way to authenticate to a private one.

### Do NOT merge — the whole chart wholesale

- **ml-hub is JupyterHub-shaped.** Weber is not a notebook server; it is an IDE
  with its own API, terminal and reactive notebook. Replacing our gateway with
  JupyterHub's proxy would mean adopting JupyterHub's identity, session and
  routing models, and then fighting them.
- **The `$VERSION` placeholder** in `Chart.yaml` and `values.yaml` is
  substituted by ml-hub's `build.py` at package time. Copying it verbatim would
  produce a broken chart.
- **ml-hub is one project's opinionated fork**, and pinned to `kubeVersion >=
  1.19`. We should take the *patterns*, not the dependency.

### Consider — adopting JupyterHub outright

An honest option I should put on the table rather than decide unilaterally:
**run real JupyterHub** and make Weber a service *behind* it, rather than
reimplementing a spawner. That is more work up front and less control, but it
inherits a mature, widely-deployed authentication and spawning stack.

---

## Revised plan for the chart

1. **Add the spawner model** — a `weber-spawner` component that creates a pod
   per user, with per-pod resource limits and a per-user PVC. This is the real
   isolation story for Kubernetes.
2. **Keep the nginx gateway** for the SPA and Weber's own API, and route
   per-user pods through it. Do not adopt `chp`; we are not routing Jupyter
   servers.
3. **Add `schema.yaml`** so bad values fail loudly at install time.
4. **Add a PodDisruptionBudget** and **pod priority** support.
5. **Add the cloud-metadata block** to the network policy. This is a real
   security gap in our chart today.
6. **Document the split**: spawner isolation for Kubernetes, `RFC-MULTIUSER.md`
   for single-host.

Items 3–5 are small and independently useful, so they can land first.
