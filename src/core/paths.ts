/**
 * Path sandbox.
 *
 * Every path reaching the core arrives as an untrusted string from a browser,
 * so resolution is centralised here and must be provably confined to a root.
 */

export class SafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafePathError";
  }
}

/** True when `child` is `root` itself or nested inside it. */
export function isInsideRoot(root: string, child: string): boolean {
  const r = stripTrailingSep(normalize(root));
  const c = stripTrailingSep(normalize(child));
  if (c === r) return true;
  // Compare on segment boundaries so "/ws-evil" is not inside "/ws".
  return c.startsWith(r + "/");
}

/**
 * Resolve an untrusted relative path against `root`.
 *
 * Rejects, rather than sanitises: a caller that sends a traversal or an
 * absolute path has a bug or bad intent, and both deserve a hard failure.
 */
export function resolveInRoot(root: string, relative: string): string {
  if (typeof relative !== "string") {
    throw new SafePathError("path must be a string");
  }
  if (relative.includes("\u0000")) {
    throw new SafePathError("path must not contain NUL bytes");
  }

  // Treat backslashes as separators everywhere so a Windows-style traversal
  // cannot slip past validation on a POSIX host and vice versa.
  const unified = relative.replace(/\\/g, "/");

  if (unified.startsWith("/")) {
    throw new SafePathError(`absolute paths are not allowed: ${relative}`);
  }
  // Windows drive ("C:/...") or UNC ("//server/share") forms.
  if (/^[a-zA-Z]:/.test(unified) || unified.startsWith("//")) {
    throw new SafePathError(`absolute paths are not allowed: ${relative}`);
  }

  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Popping past the root is an escape attempt, not a no-op.
      if (segments.length === 0) {
        throw new SafePathError(`path escapes the workspace root: ${relative}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const rootNorm = stripTrailingSep(normalize(root));
  const resolved = segments.length === 0 ? rootNorm : `${rootNorm}/${segments.join("/")}`;

  if (!isInsideRoot(rootNorm, resolved)) {
    throw new SafePathError(`path escapes the workspace root: ${relative}`);
  }
  return toNative(resolved);
}

/** Render a normalised ("/") path using the host's separator. */
function toNative(p: string): string {
  return process.platform === "win32" ? p.replace(/\//g, "\\") : p;
}

/** Normalise separators to "/" and collapse duplicate slashes. */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** Convert a resolved absolute path back to a root-relative, "/"-separated id. */
export function toRelative(root: string, absolute: string): string {
  const r = stripTrailingSep(normalize(root));
  const a = stripTrailingSep(normalize(absolute));
  if (a === r) return "";
  if (!isInsideRoot(r, a)) {
    throw new SafePathError(`path is outside the workspace root: ${absolute}`);
  }
  return a.slice(r.length + 1);
}
