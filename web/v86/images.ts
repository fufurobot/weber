/**
 * v86 image resolution.
 *
 * The disk images are **release assets**, not repository contents. A 320 MB
 * image cannot live in git: GitHub caps a single file at 100 MB, and the
 * history cost is permanent and paid by every clone forever.
 *
 * That choice has one consequence worth designing around: the image URL is a
 * runtime dependency that no build step validates. A wrong path fails in a
 * browser, after the user has already waited, so the rules live here where
 * they can be tested.
 */
import { PROFILES } from "./profiles";

/**
 * The pinned release carrying the images.
 *
 * Deliberately not `latest`: that would change underneath users, and the image
 * must match the profile metadata the code was tested against. Bumping this is
 * a deliberate act.
 */
export const DEFAULT_RELEASE = "v0.1.0";

/** Where release assets are published. */
const RELEASE_BASE = "https://github.com/fufurobot/weber/releases/download";

/** Stable asset name for a profile id. */
export function assetNameFor(profileId: string): string {
  return `weber-${profileId}-i386.img`;
}

export interface ImageUrlOptions {
  release?: string;
  /**
   * Serve images from somewhere else.
   *
   * Present so a self-hosted or offline copy can host its own images rather
   * than depending on this project's releases — which is the difference
   * between a demo and something anyone can actually run.
   */
  baseUrl?: string;
}

/** Absolute URL for a profile's image, or null when the profile is unknown. */
export function imageUrl(profileId: string, options: ImageUrlOptions = {}): string | null {
  if (!PROFILES.some((p) => p.id === profileId)) return null;

  const name = assetNameFor(profileId);
  if (options.baseUrl) {
    // Exactly one trailing slash, so callers can pass either form.
    return `${options.baseUrl.replace(/\/+$/, "")}/${name}`;
  }
  const release = options.release ?? DEFAULT_RELEASE;
  return `${RELEASE_BASE}/${release}/${name}`;
}

export interface ResolvedImage {
  available: boolean;
  profileId: string;
  url: string | null;
  assetName: string;
  approxSizeMb: number;
  reason?: string;
}

/**
 * Resolve a profile's image for display.
 *
 * Never throws: this is called from render code, where an exception blanks the
 * page and tells the user nothing.
 */
export function resolveImage(
  profileId: string,
  options: ImageUrlOptions = {},
): ResolvedImage {
  const profile = PROFILES.find((p) => p.id === profileId);
  const url = imageUrl(profileId, options);

  if (!profile || !url) {
    return {
      available: false,
      profileId,
      url: null,
      assetName: assetNameFor(profileId),
      approxSizeMb: 0,
      reason: `unknown v86 profile "${profileId}"`,
    };
  }

  return {
    available: true,
    profileId,
    url,
    assetName: assetNameFor(profileId),
    approxSizeMb: profile.approxSizeMb,
  };
}

/** Whether a profile has a resolvable image at all. */
export function isResolvable(profileId: string): boolean {
  return imageUrl(profileId) !== null;
}
