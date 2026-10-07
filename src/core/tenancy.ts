/**
 * Tenancy: mapping an authenticated user to their workspace and identity.
 *
 * A GitHub login is **attacker-controlled** — anyone can register an account —
 * so it must never be interpolated into a filesystem path without validation.
 * That single fact shapes this module: validation is not a convenience, it is
 * the boundary between a login and an arbitrary path.
 */
import { createHash } from "node:crypto";

export class InvalidLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLoginError";
  }
}

export interface RegistryOptions {
  /** First UID handed out for workspace owners. */
  baseUid?: number;
}

/**
 * GitHub's own constraints.
 *
 * Alphanumerics and single hyphens, no leading or trailing hyphen, max 39
 * characters. Enforcing the real rule is better than a looser approximation:
 * a looser rule admits logins that cannot exist, and every admitted character
 * class is one more thing the filesystem layer must tolerate.
 */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/;
const MAX_LOGIN_LENGTH = 39;

/** UID space reserved for workspace owners; 20000 keeps clear of system users. */
const DEFAULT_BASE_UID = 20_000;

export class WorkspaceRegistry {
  private readonly root: string;
  private readonly baseUid: number;
  /** Deterministic UID assignment, computed from the login rather than a counter. */
  private readonly uidCache = new Map<string, number>();

  constructor(usersRoot: string, options: RegistryOptions = {}) {
    // Normalise to forward slashes and drop any trailing separator, so joins
    // below cannot produce a doubled separator.
    this.root = usersRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    this.baseUid = options.baseUid ?? DEFAULT_BASE_UID;
  }

  /** The users root, for callers that need to check containment. */
  get usersRoot(): string {
    return this.root;
  }

  /**
   * Validate a login and return its canonical (lower-cased) form.
   *
   * Throws rather than sanitising: a login containing a separator or `..` is
   * either a bug or an attack, and silently rewriting it would hide both.
   */
  canonicalLogin(login: string): string {
    if (typeof login !== "string") {
      throw new InvalidLoginError("login must be a string");
    }
    const trimmed = login.trim();
    if (trimmed.length === 0) {
      throw new InvalidLoginError("login must not be empty");
    }
    if (trimmed.length > MAX_LOGIN_LENGTH) {
      throw new InvalidLoginError(
        `login exceeds GitHub's ${MAX_LOGIN_LENGTH}-character limit`,
      );
    }
    // Reject control characters explicitly, so the error names the real issue
    // rather than falling through to the character-class message.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new InvalidLoginError("login must not contain control characters");
    }
    if (!LOGIN_PATTERN.test(trimmed)) {
      throw new InvalidLoginError(
        `invalid login: ${JSON.stringify(trimmed)}. GitHub logins are alphanumeric ` +
          `with optional single hyphens, and may not start or end with one.`,
      );
    }
    // GitHub treats logins case-insensitively, so one person must not get two
    // workspaces by varying capitalisation.
    return trimmed.toLowerCase();
  }

  isValidLogin(login: string): boolean {
    try {
      this.canonicalLogin(login);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Absolute path to a user's workspace.
   *
   * The login has already been proven to contain no separators, no dots and no
   * control characters, so a single join cannot escape the root. The assertion
   * below is belt-and-braces against a future change to the pattern.
   */
  workspaceFor(login: string): string {
    const canonical = this.canonicalLogin(login);
    const path = `${this.root}/${canonical}`;
    if (!path.startsWith(`${this.root}/`)) {
      throw new InvalidLoginError(`workspace path escaped the users root: ${login}`);
    }
    return path;
  }

  /**
   * Deterministic UID for a workspace owner.
   *
   * Derived from the login rather than a counter, so the same user always maps
   * to the same UID across restarts and machines — a counter would reassign
   * UIDs and silently hand one user's files to another.
   */
  uidFor(login: string): number {
    const canonical = this.canonicalLogin(login);
    const cached = this.uidCache.get(canonical);
    if (cached !== undefined) return cached;

    // 16 bits of hash gives 65k slots; collisions are possible in principle and
    // must be detected by the caller that actually creates accounts.
    const digest = createHash("sha256").update(canonical).digest();
    const offset = digest.readUInt16BE(0);
    const uid = this.baseUid + offset;
    this.uidCache.set(canonical, uid);
    return uid;
  }

  /** System account name for a workspace owner. */
  systemUserFor(login: string): string {
    const canonical = this.canonicalLogin(login);
    const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
    // Keep the login visible for operator sanity, but bound it and append a
    // hash so truncation cannot cause two logins to share an account.
    const label = canonical.slice(0, 20);
    return `weber-${label}-${digest}`;
  }
}
