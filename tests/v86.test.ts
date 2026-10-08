/**
 * v86 profile manifest.
 *
 * Workstream 4: Rust and C++ on GitHub Pages with no server. v86 emulates an
 * x86 PC in the browser, so toolchains run as real native binaries rather than
 * being recompiled to WASM — which is the only route that gets `cargo` and
 * `clang` working on a static host.
 *
 * The manifest exists because the constraints are hard and a user who is not
 * told them will conclude the emulator is broken:
 *
 *   - no 64-bit kernels, so a 32-bit userland is mandatory
 *   - Pentium 4-level ISA, single core
 *   - a multi-hundred-MB image, versus Pyodide's ~6 MB
 *   - COOP/COEP for SharedArrayBuffer, which GitHub Pages will not send
 *
 * Facts from the v86 Readme (github.com/copy/v86), read rather than recalled.
 */
import { describe, expect, test } from "bun:test";
import { PROFILES, describeProfile, pickProfile } from "../web/v86/profiles";

describe("profile selection", () => {
  test("offers a profile for Rust and C++", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(ids).toContain("toolchain");
  });

  test("reports every profile's required features", () => {
    for (const p of PROFILES) {
      expect(p.requiresSharedArrayBuffer).toBeDefined();
      expect(p.approxSizeMb).toBeGreaterThan(0);
    }
  });

  test("profiles do not carry a disk image path", () => {
    // The image is a release asset resolved by images.ts. Keeping the path out
    // of the profile means there is exactly one place that knows where images
    // come from, rather than one per profile.
    for (const p of PROFILES) {
      expect((p as { imageUrl?: string }).imageUrl).toBeUndefined();
      expect(describeProfile(p.id).imageUrl).toMatch(/^https:\/\//);
    }
  });

  test("the toolchain profile is honest about its size", () => {
    // A profile that understates its size produces a page that appears to hang.
    const toolchain = PROFILES.find((p) => p.id === "toolchain")!;
    expect(toolchain.approxSizeMb).toBeGreaterThan(50);
  });

  test("every profile declares its architecture as 32-bit", () => {
    // v86 cannot boot a 64-bit kernel; offering one would fail at boot with a
    // message that means nothing to a user.
    for (const p of PROFILES) {
      expect(p.arch).toBe("i386");
    }
  });

  test("picks a profile by capability", () => {
    expect(pickProfile({ sharedArrayBuffer: true, deviceMemoryGb: 8 })).toBeDefined();
  });

  test("falls back to the minimal profile when SharedArrayBuffer is unavailable", () => {
    // Not every browser or host can provide cross-origin isolation, and the
    // minimal image boots without it. Falling back is better than refusing
    // outright, as long as the user is told what they are getting.
    const picked = pickProfile({ sharedArrayBuffer: false, deviceMemoryGb: 4 });
    expect(picked?.id).toBe("minimal");
  });

  test("refuses everything on a device below the minimum memory", () => {
    // Rather than offering a profile that will exhaust the tab and be killed.
    expect(pickProfile({ sharedArrayBuffer: true, deviceMemoryGb: 0.5 })).toBeNull();
  });

  test("prefers the most capable profile the device can run", () => {
    const picked = pickProfile({ sharedArrayBuffer: true, deviceMemoryGb: 8 });
    expect(picked?.id).toBe("toolchain");
  });
});

describe("describeProfile", () => {
  test("states the boot time and size, so the wait is expected", () => {
    const d = describeProfile("toolchain");
    expect(d.caveats.join(" ")).toMatch(/slow|10|100|second|minute/i);
    expect(d.caveats.join(" ")).toMatch(/MB/i);
  });

  test("states that it is 32-bit", () => {
    const d = describeProfile("toolchain");
    expect(d.caveats.join(" ")).toMatch(/32-bit/i);
  });

  test("warns that cross-origin isolation is required", () => {
    // SharedArrayBuffer needs COOP/COEP, which GitHub Pages does not send.
    const d = describeProfile("toolchain");
    expect(d.caveats.join(" ")).toMatch(/isolat|SharedArrayBuffer|header/i);
  });

  test("says plainly that it cannot match native speed", () => {
    const d = describeProfile("toolchain");
    expect(d.caveats.join(" ")).toMatch(/emulat|slower|not native/i);
  });

  test("an unknown profile is reported, not thrown", () => {
    const d = describeProfile("does-not-exist");
    expect(d.available).toBe(false);
  });
});
