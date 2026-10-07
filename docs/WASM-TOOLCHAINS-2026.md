# Language toolchains in the browser via WebAssembly — state of the art, 2026

Research for a browser-based IDE. Emphasis on **what actually works today**, not roadmap optimism.
Each verdict is marked **CONFIRMED** (first-party/primary source read), **PARTIAL** (works with real
limits), or **UNCONFIRMED** (could not verify — flagged rather than guessed).

---

## 1. Rust in the browser

**Verdict: rustc does NOT run in the browser. Every "Rust in a browser" product compiles on a server.**
There is no working `cargo build` in a browser.

### rustc as WASM

`rustc` has never been shipped as a browser-hostable WASM module. This is not an oversight — it is
blocked by architecture:

- rustc needs **proc-macro crates**, which are loaded as **dynamic libraries** (`dylib`) at compile
  time. `dlopen`-style dynamic linking of native code does not exist in the browser WASM sandbox.
- std requires a filesystem, threads, and process-level facilities that the browser does not expose
  to a WASM module by default.
- Precompiled `std`/`core` for a target must be shipped; a WASM-hosted rustc would need a full
  sysroot as data.

The experiments that do exist are demoware. The best-known is
[AngelOnFira/weblings](https://github.com/AngelOnFira/weblings) ("Compiling Rust to WASM from inside
WASM!"). Its framing — a proof of concept for compiling Rust from within WASM — is the honest
description of the whole field. **UNCONFIRMED:** I could not verify a maintained, released
browser-hosted rustc as of 2026. Treat any claim otherwise as marketing.

### `rustc_codegen_cranelift`

Real project ([rust-lang/rustc_codegen_cranelift](https://github.com/rust-lang/rustc_codegen_cranelift)),
a Cranelift-based codegen backend for rustc. It speeds up debug builds. **It is a codegen backend
swap, not a browser runtime.** It does not make rustc run in a browser, and it does not eliminate the
proc-macro/std/sysroot blockers above. **UNCONFIRMED:** I could not retrieve the current README
(raw.githubusercontent fetches failed repeatedly) to quote its exact stated limitations; I am not
asserting a support matrix I did not read.

### The Rust Playground

**Server-side, CONFIRMED.** The Playground is a web frontend plus a backend that compiles in
**Docker containers**. Multiple independent confirmations:

- Container-images-per-toolchain design: [rust-playground container images](https://deepwiki.com/rust-lang/rust-playground/7.2-container-images),
  [backend services](https://deepwiki.com/rust-lang/rust-playground/4-backend-services)
- A maintainer PR describes compiling "...in the orchestrated Docker container":
  [rust-playground PR #914](https://github.com/rust-lang/rust-playground/pull/914)
- Backend-only-on-Linux behaviour (Docker dependency):
  [issue #913](https://github.com/rust-lang/rust-playground/issues/913)

Your code leaves the browser, is compiled and executed on rust-lang infrastructure, and only the
output returns. This is the single most important fact for your IDE design.

### rust-analyzer web demo

rust-analyzer **does** run in-browser as WASM — this is the one genuinely in-browser Rust component.
Repo: [rust-analyzer/rust-analyzer-wasm](https://github.com/rust-analyzer/rust-analyzer-wasm)
(the long-running WIP was [PR #1746](https://github.com/rust-lang/rust-analyzer/pull/1746)).

It gives you analysis (completions, diagnostics, navigation) with **no codegen and no execution**.
This is the achievable Rust story in-browser: *analyze in the browser, compile on a server.*

### `cargo build` fully in-browser

**No.** Cargo's dependency resolution plus crates.io fetching plus compiling proc-macros is the hard
blocker. Cargo even needed a `host-config` tracking issue
([cargo #9452](https://github.com/rust-lang/cargo/issues/9452)) to decouple host/target configuration —
a prerequisite for any cross-host story, and still not a browser story.

Realistic browser-local workarounds used in practice (all narrow):
- **no_std single-file** compilation with vendored `core`
- **Fully vendored dependency trees** fetched as tarballs — no registry resolution
- **Registry resolution done server-side**, with only build artefacts shipped to the client

### What rustc-to-WASM could actually compile

Not "any crate". Realistically `no_std` code with vendored core, or a curated vendored subset. Any
crate needing proc macros, `build.rs` execution, or full std is out. **Flagging honestly:** this
boundary is inferred from the architectural blockers above (which are confirmed) rather than from a
benchmark I ran.

---

## 2. C/C++ in the browser

**Verdict: clang genuinely runs in-browser via WASM and can compile a real .c file to WASM.
clangd runs in-browser too. Both are real, and clangd is the surprising one.**

### clang/LLD in WASM — CONFIRMED, works

[binji/wasm-clang](https://github.com/binji/wasm-clang) — clang and lld compiled to WASM with WASI,
plus a **WASI in-memory filesystem (MEMFS)**, a sysroot tarball with C++ standard headers/libraries,
and a dedicated worker for compiling. Live demo: <https://binji.github.io/wasm-clang/> — **I loaded it
and it responds** (it exposes run/open/vim/emacs modes and a timing readout).

The author's own README is refreshingly candid: *"Thing should work, but it's still very much alpha
demoware."* Treat that self-assessment as current.

[soedirgo/llvm-wasm](https://github.com/soedirgo/llvm-wasm) is recommended by downstream authors as the
better build guide — see the acknowledgement in clangd-in-browser below.

Practical limits: large WASM payloads, MEMFS memory ceiling, whole toolchain download on first load,
no real process model.

### clangd in the browser — CONFIRMED, this actually works

[guyutongxue/clangd-in-browser](https://github.com/guyutongxue/clangd-in-browser) — README opens with:
*"Finally, I made clangd work in browser. You can now get C++ IntelliSense directly without installing
any native compiler or relying on a remote server."* Live demo:
<https://clangd.guyutongxue.site/>

Key engineering constraint, straight from the README: **clangd is multi-threaded, so it requires
`SharedArrayBuffer` and therefore a cross-origin-isolated context (COOP/COEP headers).** GitHub Pages
does not send these, so the author serves via Cloudflare with a custom header rule, and points to
[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) as an alternative.

**This is a deployment constraint you must plan for:** COOP/COEP breaks naive cross-origin embeds
(CDNs, images, iframes) unless those resources send CORP headers. It is a real, recurring integration
cost for any browser IDE that wants threads.

Related work named in that README: [nokotan/vscode-clangd](https://github.com/nokotan/vscode-clangd)
(a patch making the clangd VS Code extension use a WASM binary on vscode-web — author notes "Some bugs
but useful; no build scripts"), and
[ConorBobbleHat/clangd-wasm](https://github.com/ConorBobbleHat/clangd-wasm).

### Cheerp / CheerpX

[Cheerp](https://cheerp.io/docs/) is a **build-time compiler** that emits WASM/JS — you run it in CI,
not in the browser. CheerpX is the separate product for x86 virtualization in the browser. Do not
conflate the two. **PARTIAL:** cheerp.io's tour page rendered mostly chrome for me, so I am
describing the product boundary rather than quoting specifics.

### LLVM's wasm backend

LLVM has first-class `wasm32` targets (and `wasm64` work in progress). That is about **LLVM emitting
WASM** — it is *not* a statement that LLVM runs inside a browser. Those are different claims and are
frequently conflated in blog posts.

### How real browser IDEs provide C++ IntelliSense

**This is the punchline: they mostly don't.** VS Code's own documentation is explicit:

> "the terminal and debugger are not available, which makes sense since **you can't compile, run, and
> debug a Rust or Go application within the browser sandbox**."
> — [VS Code for the Web](https://code.visualstudio.com/docs/remote/vscode-web)

vscode.dev tiers language support ([same doc](https://code.visualstudio.com/docs/remote/vscode-web)):
- **Good:** syntax colorization, text-based completions, bracket colorization, plus Outline/Go to
  Symbol via **Tree-sitter** for "C/C++, C#, Java, PHP, Rust, and Go"
- **Better:** TypeScript, JavaScript, Python — real language services running natively in the browser
- **Best:** webby languages (JSON, HTML, CSS, LESS)

So in vscode.dev, **C++ gets Tree-sitter symbol navigation and not much else.** Real C++ IntelliSense
requires [GitHub Codespaces](https://code.visualstudio.com/docs/remote/codespaces) or
[Remote - Tunnels](https://code.visualstudio.com/docs/remote/tunnels) — i.e. a server.

StackBlitz WebContainers **does not support C++** — it executes only what runs natively on the web
(see §6).

---

## 3. TypeScript/JS runtimes in WASM

**Verdict: transpile/bundle in-browser is mature and shipped. Executing arbitrary Node/npm code
in-browser is not possible — except by Node-in-WASM, which is StackBlitz's proprietary trick (§6).**

### Bun — cannot be compiled to WASM (your belief is correct)

Bun wraps **JavaScriptCore**. JSC has no supported wasm32 target, and the engine is a large
JIT-dependent C++ codebase. **PARTIAL:** I found Bun repo activity *about* WebAssembly support inside
Bun (e.g. [bun #15930, "Incomplete WebAssembly namespace implementation"](https://github.com/oven-sh/bun/issues/15930)
and [bun #28534](https://github.com/oven-sh/bun/issues/28534)), and the [bun-riscv64 patches](https://github.com/elizaOS/eliza/blob/5346d8888ae71e53811f059f007f2a51d427473a/packages/app-core/scripts/bun-riscv64/webkit-patches/0006-disable-usewasm-when-webassembly-compiled-out.patch)
show JSC can be *built without* WebAssembly. **These are about Bun consuming WASM, not Bun becoming
WASM.** I did not find a Bun wasm build, which is consistent with it being architecturally out.
Beware search results conflating the two directions — that conflation is common.

Same logic for **Deno**: it wraps V8, and V8 does not run inside WASM.

### What genuinely runs in-browser

- **[esbuild-wasm](https://www.npmjs.com/package/esbuild-wasm)** — esbuild's Go core compiled to WASM.
  Bundling/transforming only. Notably **slower than native**, and it does not execute your code.
- **SWC** (`@swc/wasm-web`) — Rust-based transpiler via WASM. Transpile only.
- **TypeScript compiler API** — `tsc` in-browser; `typescript` is JS so this is not even a WASM
  question. Slow for large projects.
- **`tsgo` / typescript-go** — genuinely interesting recent development. It is a **native Go** port,
  so it is a binary, but there **is** an unofficial WASM distribution:
  [sxzz/tsgo-wasm](https://github.com/sxzz/tsgo-wasm) (`tsgo-wasm@7.0.2`), with its README stating it
  is *"**Unofficial**... automatically built daily via GitHub Actions"* and meant for "if you need to
  run it in browsers". Because Go→WASM produces large modules and Go's runtime is heavy, expect
  significant load-time cost. **Flag: unofficial distribution — no TypeScript-team support commitment.**
- **[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)** — QuickJS compiled to WASM
  for *safely executing untrusted JavaScript*. This is the most honest "run arbitrary JS in the
  browser" option. But QuickJS is an **interpreter with no Node API surface**: no `node:fs`, no
  `child_process`, no native addons, no npm ecosystem. It executes *JavaScript you hand it*, not
  *an npm package*.
- **JavaScriptCore via WASM** — no maintained general-purpose distribution. **UNCONFIRMED.**

### The decisive distinction

**Transpile/bundle in browser** (real, shipped, safe): esbuild-wasm, SWC, tsc, tsgo-wasm. These read
source and emit source. They never run your program.

**Execute arbitrary Node/npm code in browser** (not generally possible): requires `node:fs`,
`child_process`, native addons, real sockets. WASM gives none of these. The only real solution is
running Node itself in the browser — which is exactly WebContainers, and it is proprietary.

---

## 4. Pyodide

**Verdict: Pyodide is the most mature browser-hosted toolchain in existence, and its limitations are
precisely documented. It is genuinely usable — for a large subset of Python.**

Current version per docs: **314.0.7** (ABI `pyemscripten_2026_0`, with `pyemscripten_2026_5` in dev).
Sources: [Pyodide docs](https://pyodide.org/en/stable/).

### What works

- **Most of the standard library**, with a large part of the CPython test suite passing (minus
  documented skips) — [Python compatibility](https://pyodide.org/en/stable/usage/wasm-constraints.html)
- **~400 packages pre-built**, including heavy native ones — `numpy 2.4.6`, `pandas 3.0.2`,
  `scipy 1.18.0`, `scikit-learn 1.8.0`, `matplotlib 3.10.8`, `opencv-python`, `pyarrow 22.0.0`,
  `duckdb 1.5.1`, `xgboost`, `lightgbm`, `lxml`, `pyproj`, `shapely`, `sympy`, `polars 1.33.1`.
  Full list: [Packages built in Pyodide](https://pyodide.org/en/stable/usage/packages-in-pyodide.html)
- **`micropip`** installs pure-Python wheels straight from PyPI with dependency resolution and hash
  verification against the PyPI JSON API. Custom index URLs supported.
  [Loading packages](https://pyodide.org/en/stable/usage/loading-packages.html)

### Filesystem — CONFIRMED, and better than expected

- Default FS is Emscripten **MEMFS** (in-memory, loses data on reload).
- Persistence via **IDBFS** (IndexedDB) — mount and sync.
- **Native FS via `pyodide.mountNativeFS()`** using the File System Access API — **experimental, and
  Chromium-only (Chrome/Edge)**. Crucially, **changes are NOT auto-synced**: you must call
  `nativefs.syncfs()` explicitly or you will silently lose writes.
  [Filesystem docs](https://pyodide.org/en/stable/usage/file-system.html)

### Networking — the awkward part

Sockets are **not available**. `pyodide.http` provides `pyfetch`/`open_url` built on browser `fetch`.
Synchronous HTTP (`requests`, `urllib3`) works **only roughly**, and streaming downloads require
**both** a web worker **and** a cross-origin-isolated page. All network calls are subject to CORS;
you have little control over certs, timeouts, or proxies.
[Python compatibility](https://pyodide.org/en/stable/usage/wasm-constraints.html)

### What does NOT work — CONFIRMED

- **Threading and `multiprocessing`: importable but non-functional.** Any package using them needs a
  patch. The docs' own detection snippet checks `sys._emscripten_info.pthreads` and treats `wasm32`
  as "cannot start thread".
- **Modules removed entirely:** `curses`, `dbm`, `fcntl`, `grp`, `pwd`, `resource`, `syslog`,
  `termios`, `tkinter`, `turtle`, `venv`, `msvcrt`, `winreg`, `winsound`, `lib2to3`, `ensurepip`.
- **`pty`/`tty`** cannot even be imported (depend on removed `termios`).
- **`ssl` is a stub** without OpenSSL; hashlib algorithms depending on OpenSSL are missing.
- **Native extensions are NOT installable by the user.** `micropip` handles pure-Python wheels and
  *pre-built* wasm32/emscripten wheels only. An arbitrary PyPI sdist or x86 `.so` cannot be built or
  loaded. This is the single biggest practical limitation.
- **`venv` is gone** — no virtualenvs.

### Performance and load — CONFIRMED

- **~6.4 MB first download, 4–5 s init** (cached on subsequent loads) — stated on the
  [roadmap](https://pyodide.org/en/stable/project/roadmap.html)
- Python code runs **~3–5× slower than native**
- Notably, **C code compiled to WASM runs near-native to 2–2.5× slower** — the overhead is the
  Python interpreter, not WASM

---

## 5. How real products actually do it — the comparison that matters

| Product | Where the toolchain runs | In browser? | Evidence |
|---|---|---|---|
| **Rust Playground** | Server: Docker container per toolchain | ❌ No | [container images](https://deepwiki.com/rust-lang/rust-playground/7.2-container-images), [PR #914](https://github.com/rust-lang/rust-playground/pull/914) |
| **Binder / JupyterHub** | Server: Kubernetes pods from repo2docker images | ❌ No | [BinderHub architecture](https://binderhub.readthedocs.io/en/latest/overview.html) |
| **Google Colab** | Server: Google-hosted VM | ❌ No | **UNCONFIRMED** — see note |
| **GitHub Codespaces** | Server: cloud VM; browser is the frontend | ❌ No | [What are Codespaces](https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces) |
| **StackBlitz WebContainers** | **Browser** — WASM-based OS running Node.js | ✅ **Yes** | [Introduction](https://webcontainers.io/guides/introduction) |
| **vscode.dev (web-only)** | Browser, but **no runtime** — no terminal, no compile/debug | ⚠️ Editing only | [VS Code for the Web](https://code.visualstudio.com/docs/remote/vscode-web) |
| **Gitpod** | Server: Kubernetes-hosted remote workspace | ❌ No | **PARTIAL** — see note |

**Google Colab — UNCONFIRMED.** Colab is universally understood to execute on Google-hosted VMs and
mounts Drive rather than running locally, but I could not retrieve a first-party Colab doc stating
the compute location explicitly within this research. I will not present it as confirmed.

**Gitpod — PARTIAL.** My search surfaced a [Software Engineering Daily transcript (PDF)](https://softwareengineeringdaily.com/wp-content/uploads/2020/10/SED1148-Gitpod.pdf)
describing Gitpod as "a Kubernetes application running in basically two Kubernetes clusters". That
supports the server-side model but is a 2020 interview, not current official documentation. Note
Gitpod has restructured its product line since; treat the specific architecture as dated.

### The pattern to extract

**Seven products, one browser-side toolchain.** Only StackBlitz genuinely runs a language toolchain
in the browser — and only for the JavaScript/Node ecosystem, via a proprietary engine. Every
general-purpose, multi-language product put compute on a server. That is the strongest available
signal about where this technology actually stands in 2026. Anything claiming otherwise is either
(a) a narrow single-language WASM port like Pyodide, or (b) doing the work server-side behind a
browser frontend.

---

## 6. WebContainers specifically

**Verdict: Yes, it is real and it is WASM-based. No, it does not run arbitrary binaries — only Node
plus a curated WASM-recompiled toolset.**

Mechanism, per StackBlitz ([Introducing WebContainers](https://blog.stackblitz.com/posts/introducing-webcontainers/)):
- A **"WebAssembly-based operating system powerful enough to run Node.js, entirely inside your
  browser"** — they describe it as *"a WebAssembly-based operating system"*
- The **virtualized TCP network stack is mapped to the ServiceWorker API**, which is how in-browser
  servers serve real HTTP: *"a virtualized TCP network stack that's mapped to your browser's
  ServiceWorker API"*
- Filesystem, processes, and a **real npm client** (originally `turbo`, now the real npm CLI)
- Because your project's ServiceWorker is occupied by the networking stack, **you cannot install your
  own ServiceWorker** — a real architectural constraint

**This means it is not "Node.js compiled to WASM" in the naive sense — it is a re-implementation of
the Node environment on top of WASM + browser APIs.** Their own 2021 post mused about "running
non-web native languages like Python, Java, or R in the browser via WASI" as *future* work — i.e. not
done, and that framing has not been retired.

### The decisive limitation — CONFIRMED, first-party

> "Currently, WebContainers can only execute languages that are natively supported on the Web,
> including JavaScript and WebAssembly. **It is not possible to run native addons** which are usually
> implemented using native languages such as C++, unless they can be compiled to WebAssembly.
> Therefore, loading native addons is disabled by default via `--no-addons` in WebContainers."
> — [Troubleshooting WebContainers](https://developer.stackblitz.com/platform/webcontainers/troubleshooting-webcontainers)

So: **arbitrary binaries → no. Native npm addons → no (`--no-addons`)**, unless recompiled to WASM.
This directly answers §3's question — and it is why C++ and Rust do not work in StackBlitz.

---

## 7. HPC / remote

**Verdict: Always server-side compute with a browser frontend. Nobody ships WASM toolchains for HPC.
The browser is universally a thin client to a scheduler-backed compute node.**

### Open OnDemand — CONFIRMED, fully server-side

From the [official architecture docs](https://osc.github.io/ood-documentation/latest/architecture.html):
- **Apache** is the frontend: authenticates, starts **Per-User NGINX (PUN)** processes, and reverse
  proxies over Unix domain sockets
- **It reverse-proxies to interactive apps running on compute nodes (RStudio, Jupyter, VNC desktop)
  via TCP sockets**
- The per-user NGINX runs Ruby/NodeJS apps to submit jobs and launch interactive apps

So the browser renders a remote desktop / remote Jupyter / remote app. Compilation and execution
happen on HPC nodes. There is no WASM toolchain anywhere in this picture.

### BinderHub / JupyterHub — CONFIRMED, fully server-side

Per [BinderHub architecture](https://binderhub.readthedocs.io/en/latest/overview.html): a click
triggers → BinderHub resolves the repo → builds a **Docker image via repo2docker** in a build pod →
pushes to a **registry** → **JupyterHub creates a Kubernetes pod** serving that image → the pod is
destroyed after inactivity. Compute location: Kubernetes, unambiguously.

### code-server

Runs the full server-side VS Code in a container on the cluster; the browser is a terminal to it.
**PARTIAL:** I did not retrieve first-party code-server architecture docs; this describes the
universally documented deployment model.

### Does anyone ship WASM toolchains for HPC browser IDEs?

**No — and the reasoning is decisive.** HPC users need:
- MPI and multi-node execution
- GPUs / accelerators
- Real schedulers (Slurm, PBS) and job queues
- Container stacks — **Singularity/Apptainer** and AppImage, chosen precisely because HPC nodes
  forbid Docker's privileged daemon model
- Large-scale filesystems (Lustre, GPFS)

None of these are representable in a browser WASM sandbox. WASM has no MPI, no GPUs (WebGPU is
graphics-compute, not CUDA), no Slurm client semantics, and cannot host a Singularity runtime. The
browser's role in HPC is **rendering and interaction**: X/VNC desktops, Jupyter, and web terminals —
with compute on the node.

---

## What is actually achievable in-browser in 2026 vs what must run server-side

### Achievable in-browser today (confirmed)

| Capability | Status | Notes |
|---|---|---|
| **Python execution** (Pyodide) | ✅ Mature | ~400 packages incl. numpy/scipy/pandas; no threads, no sockets, no user-built native exts |
| **C/C++ compilation to WASM** | ✅ Works, demoware-grade | wasm-clang compiles real .c; author calls it "alpha demoware" |
| **C++ IntelliSense (clangd)** | ✅ Works | **Requires COOP/COEP + SharedArrayBuffer** |
| **Rust analysis** | ✅ Works | rust-analyzer WASM; analysis only |
| **JS/TS bundling & transpiling** | ✅ Mature | esbuild-wasm, SWC, tsc, tsgo-wasm (unofficial) |
| **Untrusted JS execution** | ✅ Works | quickjs-emscripten; no Node APIs, no npm |
| **Node.js + npm + dev servers** | ✅ Works (proprietary) | WebContainers only; **no native addons** |
| **Tree-sitter symbol navigation** | ✅ Mature | C/C++, C#, Java, PHP, Rust, Go even in vscode.dev |

### Must run server-side (confirmed)

| Capability | Why |
|---|---|
| **`cargo build` / crates.io resolution** | Proc-macro dylibs + std + registry access; no browser equivalent |
| **rustc itself** | Proc-macro dynamic loading; no filesystem/threads |
| **Arbitrary PyPI native extensions** | Requires compiling C/C++/Fortran per-user; micropip takes prebuilt wheels only |
| **Python threads / multiprocessing** | Importable but non-functional in Pyodide |
| **Real sockets, TLS control, proxies** | Browser networking policy; CORS applies |
| **C++/Rust *execution*** | Nothing runs them in-browser; even StackBlitz can't (`--no-addons`) |
| **Terminals, debuggers, native binaries** | No process model in the browser sandbox |
| **HPC workloads (MPI, GPU, Slurm, Singularity)** | Architecturally unrepresentable in WASM |

### The honest engineering conclusion

The browser can do **analysis, transpilation, single-language interpretation, and (for Node only) a
re-implemented runtime**. It cannot do **general compilation, native dependency builds, or native
execution**.

The distribution is stark and worth internalizing: **Pyodide and WebContainers are the two genuine
successes, and both are the result of a decade-plus of dedicated effort on a *specific* language
ecosystem.** Neither generalizes to "run any toolchain in the browser". Seven major browser IDE
products were surveyed; six put compute on a server.

For a browser IDE, the defensible architecture is:

> **WASM in-browser for what is genuinely cheap and latency-sensitive** — syntax analysis (Tree-sitter),
> language-server-grade analysis where a port exists (rust-analyzer, clangd, Pyodide), and
> transpilation (esbuild/SWC) — **with compilation and execution on a server** (container/VM per
> workspace), reached over a persistent connection, with the browser as the frontend.

Attempting to force compilation into the browser will consume enormous effort to reach
"alpha demoware" (wasm-clang's own words) and will still fail on dependency resolution, proc macros,
and native extensions — the three things real projects need most.

### Flagged as unconfirmed

1. **Any browser-hosted rustc** — no confirmed maintained build; architectural blockers are confirmed.
2. **`rustc_codegen_cranelift` current README limitations** — raw fetches failed repeatedly; I do not
   assert its support matrix.
3. **Google Colab's compute location from a first-party doc** — widely understood to be server-side
   VMs, but I could not retrieve the authoritative statement.
4. **Gitpod's current architecture** — only a 2020 interview transcript, and the product has
   restructured since.
5. **Cheerp/CheerpX specifics** — docs page rendered incompletely; I describe the product boundary only.
6. **JavaScriptCore-via-WASM** — no maintained distribution found, but absence of evidence is not proof.
7. **The exact no_std/any-crate boundary for a hypothetical wasm rustc** — inferred from confirmed
   architectural blockers, not from a benchmark.
