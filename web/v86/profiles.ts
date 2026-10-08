/**
 * v86 profiles.
 *
 * Workstream 4: Rust and C++ on GitHub Pages with no server. v86 emulates an
 * x86 PC in the browser, so toolchains run as **real native binaries** rather
 * than being recompiled to WASM. That is the only route that gets `cargo` and
 * `clang` working on a static host — the WASM paths cannot, for the reasons in
 * `docs/WASM-TOOLCHAINS-2026.md`.
 *
 * Constraints are from the v86 Readme, read rather than recalled:
 *   - "64-bit kernels are not supported"  → 32-bit userland only
 *   - Pentium-4-level ISA, no multi-core
 *   - Buildroot / Alpine / Arch-32 are the supported minimal images
 *   - Ubuntu works only up to 16.04/18.04, the last i386 releases
 *
 * These are hard limits, not tuning knobs, so the UI states them instead of
 * letting a user conclude the emulator is broken.
 */
import { imageUrl } from "./images";

export type Arch = "i386";

export interface V86Profile {
  id: string;
  label: string;
  /** v86 cannot boot 64-bit kernels, so this is always i386. */
  arch: Arch;
  /**
   * Extra images the profile needs to boot.
   *
   * The disk image itself is NOT here: it is a release asset resolved at
   * runtime by `images.ts`, because a 320 MB file cannot live in git. Keeping
   * the two apart means there is exactly one place that knows where images
   * come from.
   */
  bios?: { url: string };
  vgaBios?: { url: string };
  /** Default kernel command line, if the image is booted as a bzImage. */
  cmdline?: string;
  /**
   * SharedArrayBuffer needs cross-origin isolation (COOP/COEP). Recorded
   * rather than assumed, because a static host that cannot send those headers
   * makes this profile unusable.
   */
  requiresSharedArrayBuffer: boolean;
  /** Rough minimum device memory, in GiB, for the image plus toolchain. */
  minMemoryGb: number;
  /** Memory the VM itself is given, in MiB. */
  vmMemoryMb: number;
  /** Download size, surfaced so the wait is expected rather than mysterious. */
  approxSizeMb: number;
}

export const PROFILES: V86Profile[] = [
  {
    id: "toolchain",
    label: "Linux with Rust and C/C++ (32-bit)",
    arch: "i386",
    // Buildroot is the supported way to get a small bootable system; a full
    // distribution is several hundred MB before a toolchain is added.
    approxSizeMb: 320,
    bios: { url: "bios/seabios.bin" },
    vgaBios: { url: "bios/vgabios.bin" },
    cmdline: "console=ttyS0 root=/dev/sda",
    requiresSharedArrayBuffer: true,
    minMemoryGb: 2,
    vmMemoryMb: 1024,
  },
  {
    id: "minimal",
    label: "Minimal Linux (shell only)",
    arch: "i386",
    // Useful as a fallback: it boots quickly and proves the emulator works
    // before committing a user to a 320 MB download.
    approxSizeMb: 12,
    bios: { url: "bios/seabios.bin" },
    vgaBios: { url: "bios/vgabios.bin" },
    requiresSharedArrayBuffer: false,
    minMemoryGb: 1,
    vmMemoryMb: 512,
  },
];

export interface DeviceCapabilities {
  sharedArrayBuffer: boolean;
  deviceMemoryGb: number;
}

/**
 * Choose a profile the device can actually run.
 *
 * Returns null rather than falling back to a profile that would fail: a
 * silently-degraded emulator is harder to diagnose than an explicit "this
 * device cannot run it, and here is why".
 */
export function pickProfile(caps: DeviceCapabilities): V86Profile | null {
  const viable = PROFILES.filter(
    (p) =>
      (!p.requiresSharedArrayBuffer || caps.sharedArrayBuffer) &&
      caps.deviceMemoryGb >= p.minMemoryGb,
  );
  if (viable.length === 0) return null;
  // Prefer the most capable profile the device can handle.
  return viable.reduce((best, p) => (p.approxSizeMb > best.approxSizeMb ? p : best));
}

export interface ProfileDescription {
  id: string;
  label: string;
  available: boolean;
  imageUrl: string;
  /** What the user must be told before they wait for a 320 MB download. */
  caveats: string[];
}

const CAVEATS: Record<string, string[]> = {
  toolchain: [
    "Emulated, so expect it to be much slower than running natively — this is interpretation, not native execution.",
    "Boot takes tens of seconds and the image is roughly 320 MB, so the first visit is slow.",
    "32-bit only: v86 cannot boot a 64-bit kernel, which rules out modern Ubuntu and most current toolchains.",
    "Needs cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer. GitHub Pages does not send them, so this profile needs a host that does.",
    "The VM's memory comes out of your browser tab; a large build can exhaust it.",
  ],
  minimal: [
    "A shell, with no compilers — useful for checking the emulator works before a large download.",
    "Emulated, so slower than the host by a wide margin.",
    "32-bit only.",
  ],
};

/**
 * Describe a profile for display.
 *
 * An unknown id returns `available: false` rather than throwing, because this
 * is called from rendering code where an exception would blank the page.
 */
export function describeProfile(id: string): ProfileDescription {
  const profile = PROFILES.find((p) => p.id === id);
  if (!profile) {
    return {
      id,
      label: "Unknown profile",
      available: false,
      imageUrl: "",
      caveats: [`No v86 profile named "${id}" is configured.`],
    };
  }
  // The image URL is resolved separately, since it points at a release asset.
  return {
    id: profile.id,
    label: profile.label,
    available: true,
    imageUrl: imageUrl(profile.id) ?? "",
    caveats: [...(CAVEATS[profile.id] ?? [])],
  };
}
