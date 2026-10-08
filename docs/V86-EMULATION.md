# v86: Rust and C++ with no server

> **Status: DEFERRED.** The decision logic, profile metadata and image
> resolution are implemented and tested. **The disk image does not exist and no
> emulator has ever been run.** Nothing in the UI imports this code yet, so the
> feature is inert rather than half-working — which is the honest state to
> leave it in.
>
> Resuming this needs a Linux host. Buildroot requires a case-sensitive POSIX
> filesystem and builds a full host toolchain; it explicitly does not support
> MSYS2, and the development environment has neither a container runtime nor a
> WSL distro (virtualization is disabled at the host level). GitHub runners can
> do it, but a Buildroot toolchain build is measured in hours, which is why it
> would be a manually triggered job rather than part of every push.

How workstream 4 is intended to work, why it is the only route to those
toolchains on a static host, and what it costs.

Constraints below come from the [v86 Readme](https://github.com/copy/v86),
read rather than recalled.

---

## Why an emulator, when WASM exists

`docs/WASM-TOOLCHAINS-2026.md` establishes that `rustc` cannot run in a
browser and `cargo build` cannot resolve crates there: proc-macro crates load
as dynamic libraries (`dlopen` is absent), `std` needs a filesystem and
threads, and a sysroot must ship as data.

**v86 sidesteps all of that by not recompiling anything.** It emulates an x86
PC, boots a real Linux kernel, and runs the toolchain as unmodified native
binaries. The blockers for WASM are not blockers here, because there is a real
kernel underneath.

| | Pyodide | WASM toolchains | v86 |
|---|---|---|---|
| Real `cargo build` | n/a | **No** | **Yes** |
| Real `clang`/`gcc` | n/a | Partial, "alpha demoware" | **Yes** |
| Download | ~6 MB | ~10–30 MB | **~320 MB** |
| Speed | 3–5× slower than native | near-native | **10–100× slower** |
| Needs COOP/COEP | no | for clangd | **yes, for SAB** |
| 64-bit | n/a | n/a | **no** |

---

## Hard constraints

These are properties of v86 and of x86, not tuning knobs:

1. **No 64-bit kernels.** v86's Readme is explicit. That means a 32-bit
   userland, which rules out modern Ubuntu (i386 was dropped after 18.04),
   most current Rust tier-1 targets, and anything assuming 64-bit pointers.
2. **Pentium-4-level ISA, single core.** No AVX, no multi-core builds. `-j4`
   gives no speedup.
3. **Interpretation, not native execution.** Expect one to two orders of
   magnitude slower. A `cargo build` of a non-trivial crate is minutes, not
   seconds.
4. **Memory comes from the tab.** A 1 GiB VM plus the emulator is enough to
   get a browser tab killed on a small device.
5. **COOP/COEP for `SharedArrayBuffer`.** GitHub Pages does not send those
   headers, so the full profile needs a host that does. This is the same
   constraint that blocks in-browser `clangd`.

Point 5 is worth stating plainly because it partially undercuts the goal: the
"Pages-only" claim holds for the *files*, but the full-speed profile needs
headers Pages will not provide. The minimal profile boots without SAB, which is
why it exists as a fallback.

---

## Profiles

| id | Contents | Size | Needs SAB |
|---|---|---|---|
| `toolchain` | Linux with Rust and C/C++ | ~320 MB | yes |
| `minimal` | Shell only, no compilers | ~12 MB | no |

`pickProfile()` returns the most capable profile a device can run, or `null`.
It never silently downgrades to something that will fail — an explicit refusal
is far easier to diagnose than an emulator that boots to a black screen.

The `minimal` profile exists so a user can confirm the emulator works before
committing to a 320 MB download. That is a real usability benefit, not filler.

---

## Building the image

**Not done.** No script is committed, deliberately: an earlier draft referenced
a Buildroot defconfig and board directory that were never written, so it could
not run. A build script that cannot build is worse than none, because it looks
like the work is further along than it is.

What it would take, in order:

1. A Buildroot defconfig for a 32-bit x86 target, plus a board directory with
   an overlay adding the toolchain packages.
2. A build script that fetches Buildroot, applies the defconfig, and collects
   `rootfs.ext2` plus the BIOS blobs v86 needs.
3. A GitHub Actions job to run it. Expect hours, so it should be manually
   triggered or on a schedule, not on every push.
4. Publishing the result as a release asset, which is what
   `web/v86/images.ts` already expects — it resolves a pinned release URL and
   supports a `baseUrl` override so a self-hosted copy can serve its own image.

The open question worth settling before writing any of it: **is a 10–100×
slower toolchain in a browser tab actually useful**, or is it a demonstration?
If the answer is demonstration, the effort may not be worth it, and the honest
alternative is the Helm chart or the compose path.

---

## Where the images live

v86 loads images over XHR, so they must be served from the same origin as the
page. For a Pages deployment that means committing them to the repository,
which is a real cost:

- 320 MB in git history, permanently
- GitHub's per-file limit (100 MB) means the image must be split or hosted
  elsewhere
- every clone pays for it, forever

**Recommended instead:** publish the image as a **release asset** and fetch it
from `github.com/.../releases/download/...`. Release assets are not in git
history, can exceed 100 MB, and are cacheable. The tradeoff is that they are on
a different origin, so the fetch needs CORS — which release assets do send.

This is a decision to make before building the image, because fixing it
afterwards means rewriting history.

---

## What this does not give you

- **Native speed.** It is an emulator.
- **Modern toolchains.** 32-bit only.
- **64-bit anything.**
- **A substitute for the server.** The chart and `podman-compose` paths remain
  the way to run real workloads; v86 is for trying things with no backend at
  all.

If the goal is genuine development rather than demonstration, the honest advice
is still `podman-compose up` or the Helm chart.
