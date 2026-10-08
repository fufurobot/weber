/**
 * v86 image resolution.
 *
 * A 320 MB disk image cannot live in git: GitHub caps files at 100 MB, and the
 * history cost is permanent and paid by every clone forever. So the image is a
 * **release asset**, and the app resolves a URL for it at runtime.
 *
 * That introduces the thing this module is really about: a URL that can be
 * wrong in ways a build cannot catch. A bad path 404s at runtime, in a browser,
 * after the user has already waited — so the resolution rules are pinned here.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELEASE,
  imageUrl,
  resolveImage,
  assetNameFor,
  isResolvable,
} from "../web/v86/images";

describe("asset naming", () => {
  test("derives a stable asset name per profile", () => {
    expect(assetNameFor("toolchain")).toBe("weber-toolchain-i386.img");
    expect(assetNameFor("minimal")).toBe("weber-minimal-i386.img");
  });

  test("names are distinct per profile", () => {
    // A collision would serve the wrong image, which boots to something the
    // user did not ask for.
    const names = ["toolchain", "minimal"].map(assetNameFor);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("image URL", () => {
  test("points at a release download, not a repository path", () => {
    // Anything under the repo would blow the 100 MB limit.
    const url = imageUrl("toolchain");
    expect(url).toContain("/releases/download/");
    expect(url).not.toContain("/raw/");
  });

  test("includes the release tag", () => {
    const url = imageUrl("toolchain", { release: "v9.9.9" });
    expect(url).toContain("/download/v9.9.9/");
  });

  test("defaults to a pinned release rather than latest", () => {
    // `latest` silently changes underneath users and cannot be rolled back;
    // the image must match the profiles the code was tested with.
    const url = imageUrl("toolchain");
    expect(url).toContain(`/download/${DEFAULT_RELEASE}/`);
    expect(url).not.toContain("/latest/");
  });

  test("is absolute, since Pages serves from a subpath", () => {
    expect(imageUrl("toolchain")).toMatch(/^https:\/\//);
  });

  test("an unknown profile yields no URL rather than a broken one", () => {
    expect(imageUrl("does-not-exist")).toBeNull();
  });
});

describe("resolveImage", () => {
  test("resolves an available profile", () => {
    const r = resolveImage("toolchain");
    expect(r.available).toBe(true);
    expect(r.url).toBeTruthy();
    expect(r.assetName).toBe(assetNameFor("toolchain"));
  });

  test("reports an unknown profile without throwing", () => {
    // Called from render code, where a throw blanks the page.
    const r = resolveImage("nope");
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/unknown/i);
  });

  test("allows an override, so a self-hosted copy can serve its own image", () => {
    // The project must not be the only place these images can come from.
    const r = resolveImage("toolchain", { baseUrl: "https://example.test/v86/" });
    expect(r.url).toBe("https://example.test/v86/weber-toolchain-i386.img");
  });

  test("an override is normalised to exactly one trailing slash", () => {
    expect(resolveImage("toolchain", { baseUrl: "https://x.test/a" }).url).toBe(
      "https://x.test/a/weber-toolchain-i386.img",
    );
    expect(resolveImage("toolchain", { baseUrl: "https://x.test/a//" }).url).toBe(
      "https://x.test/a/weber-toolchain-i386.img",
    );
  });

  test("explains the download size, so the wait is expected", () => {
    const r = resolveImage("toolchain");
    expect(r.approxSizeMb).toBeGreaterThan(50);
  });
});

describe("isResolvable", () => {
  test("true only for profiles with a URL", () => {
    expect(isResolvable("toolchain")).toBe(true);
    expect(isResolvable("minimal")).toBe(true);
    expect(isResolvable("nope")).toBe(false);
  });
});
