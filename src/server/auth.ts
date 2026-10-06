/**
 * GitHub OAuth device-flow authentication.
 *
 * Weber exposes file access and a command runner. That is fine on loopback and
 * unacceptable on a public address, so a public deployment must be gated.
 *
 * The **device flow** is used rather than the web-redirect flow, deliberately:
 * it needs only a client ID (no client secret to store, leak or rotate on a
 * single-VM deployment), and it works when the host is reached over an SSH
 * tunnel where a browser redirect to localhost would not resolve.
 *
 * Flow:
 *   1. POST /api/auth/device  -> device_code + user_code + verification_uri
 *   2. the user enters the code at github.com/login/device
 *   3. POST /api/auth/poll    -> access_token once approved
 *   4. the token is exchanged for a signed, HttpOnly session cookie
 *
 * Authorization is a separate step: an approved GitHub account is not
 * automatically allowed. Only logins in ALLOWED_LOGINS may sign in, because
 * "can authenticate" and "is permitted" are different questions and conflating
 * them turns any GitHub account into a shell on this box.
 */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name?: string | null;
  avatar_url?: string;
}

export interface AuthConfig {
  clientId: string;
  /** GitHub logins permitted to use this instance. Empty means "deny all". */
  allowedLogins: string[];
  /** Secret used to sign session tokens. */
  sessionSecret: string;
  /** Session lifetime in seconds. */
  sessionTtlSeconds?: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class AuthService {
  private readonly ttl: number;

  constructor(private readonly config: AuthConfig) {
    this.ttl = config.sessionTtlSeconds ?? 60 * 60 * 12;
  }

  /** True when the deployment is gated at all. */
  get enabled(): boolean {
    return this.config.clientId.length > 0 && this.config.allowedLogins.length > 0;
  }

  /** Beginner of the device flow. */
  async startDeviceFlow(): Promise<DeviceCodeResponse> {
    if (!this.enabled) {
      throw new AuthError("authentication is not configured", 503);
    }
    const res = await fetch(GITHUB_DEVICE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.config.clientId, scope: "read:user" }),
    });
    if (!res.ok) {
      throw new AuthError(`github rejected the device request (${res.status})`, 502);
    }
    return (await res.json()) as DeviceCodeResponse;
  }

  /**
   * Exchange a device code for a session token.
   *
   * GitHub returns 200 with an `error` field for the pending/slow_down cases,
   * so the body must be inspected rather than the status code alone.
   */
  async pollForToken(deviceCode: string): Promise<{ token: string; user: GitHubUser }> {
    if (!this.enabled) throw new AuthError("authentication is not configured", 503);

    const res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      }),
    });

    const body = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (body.error === "authorization_pending") {
      throw new AuthError("authorization pending", 428);
    }
    if (body.error === "slow_down") {
      throw new AuthError("slow down", 429);
    }
    if (body.error === "expired_token") {
      throw new AuthError("the device code expired; start again", 410);
    }
    if (body.error || !body.access_token) {
      throw new AuthError(body.error_description ?? body.error ?? "authorization failed", 401);
    }

    const user = await this.fetchUser(body.access_token);

    // Authenticating is not the same as being permitted.
    if (!this.isAllowed(user.login)) {
      throw new AuthError(
        `${user.login} is not permitted to use this instance`,
        403,
      );
    }

    return { token: body.access_token, user };
  }

  isAllowed(login: string): boolean {
    const target = login.toLowerCase();
    return this.config.allowedLogins.some((l) => l.toLowerCase() === target);
  }

  private async fetchUser(token: string): Promise<GitHubUser> {
    const res = await fetch(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "weber",
      },
    });
    if (!res.ok) throw new AuthError(`could not read the GitHub profile (${res.status})`, 502);
    return (await res.json()) as GitHubUser;
  }

  /** Mint a signed session token: `<payload>.<hmac>`. */
  async createSession(user: GitHubUser): Promise<string> {
    const payload = JSON.stringify({
      login: user.login,
      id: user.id,
      exp: Math.floor(Date.now() / 1000) + this.ttl,
    });
    const encoded = base64url(new TextEncoder().encode(payload));
    const sig = await this.sign(encoded);
    return `${encoded}.${sig}`;
  }

  /** Verify a session token, returning the identity or null. */
  async verifySession(token: string | undefined | null): Promise<{ login: string; id: number } | null> {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;

    const encoded = token.slice(0, dot);
    const provided = token.slice(dot + 1);

    // Constant-time compare: a length/prefix leak here would let an attacker
    // forge a session one byte at a time.
    if (!timingSafeEqual(provided, await this.sign(encoded))) return null;

    try {
      const payload = JSON.parse(new TextDecoder().decode(fromBase64url(encoded))) as {
        login: string;
        id: number;
        exp: number;
      };
      if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      if (typeof payload.login !== "string") return null;
      // Re-check the allow-list so revoking access takes effect immediately
      // rather than after the session expires.
      if (!this.isAllowed(payload.login)) return null;
      return { login: payload.login, id: payload.id };
    } catch {
      return null;
    }
  }

  sessionTtl(): number {
    return this.ttl;
  }

  private async sign(data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.config.sessionSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return base64url(new Uint8Array(sig));
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Compare two strings without leaking length or prefix through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse "a,b, c" into a clean login list. */
export function parseAllowedLogins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
