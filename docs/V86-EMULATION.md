# v86: Rust and C++ with no server

How workstream 4 works, why it is the only route to those toolchains on a
static host, and what it costs.

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

v86's supported path for a small bootable system is **Buildroot**; Alpine and
32-bit Arch also work. A full distribution is several hundred MB before a
toolchain is added.

Sketch:

```bash
# Buildroot with a 32-bit x86 defconfig, then add to the rootfs:
#   rust (i686 target)   — check tier support before assuming
#   gcc or clang         — 32-bit host toolchain
#   make, pkg-config, musl or glibc
make -C buildroot weber_i386_defconfig
make -C buildroot
# Emit a disk image v86 can boot, plus seabios.bin and vgabios.bin.
```

**Not yet done, and not verified.** The manifest, selection logic and caveats
are implemented and tested; the image itself is not built, and no emulator has
been run. That distinction matters and is repeated in
`docs/IMPLEMENTATION.md`.

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
