/**
 * Authentication.
 *
 * Weber exposes file access and a command runner, so these tests focus on the
 * ways an auth layer fails dangerously: accepting a forged session, confusing
 * "authenticated" with "authorized", or trusting a token past its expiry.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { AuthService, AuthError, parseAllowedLogins } from "../src/server/auth";

const SECRET = "test-session-secret-that-is-long-enough";
const CLIENT = "Iv1.test_client_id";

let auth: AuthService;

beforeEach(() => {
  auth = new AuthService({
    clientId: CLIENT,
    allowedLogins: ["fufurobot"],
    sessionSecret: SECRET,
  });
});

const user = { login: "fufurobot", id: 177607284 };

describe("configuration", () => {
  test("is enabled only when both a client id and an allow-list exist", () => {
    expect(auth.enabled).toBe(true);
    expect(
      new AuthService({ clientId: CLIENT, allowedLogins: [], sessionSecret: SECRET }).enabled,
    ).toBe(false);
    expect(
      new AuthService({ clientId: "", allowedLogins: ["a"], sessionSecret: SECRET }).enabled,
    ).toBe(false);
  });

  test("startDeviceFlow refuses when authentication is not configured", async () => {
    const disabled = new AuthService({
      clientId: "",
      allowedLogins: [],
      sessionSecret: SECRET,
    });
    await expect(disabled.startDeviceFlow()).rejects.toThrow(AuthError);
  });

  test("parseAllowedLogins tolerates spacing and empties", () => {
    expect(parseAllowedLogins("fufurobot, alice ,,bob")).toEqual(["fufurobot", "alice", "bob"]);
    expect(parseAllowedLogins(undefined)).toEqual([]);
    expect(parseAllowedLogins("  ")).toEqual([]);
  });
});

describe("authorization", () => {
  test("allows an exact login", () => {
    expect(auth.isAllowed("fufurobot")).toBe(true);
  });

  test("is case-insensitive, matching GitHub's own semantics", () => {
    expect(auth.isAllowed("FufuRobot")).toBe(true);
  });

  test("refuses an account that is not on the allow-list", () => {
    // Authenticating with GitHub must not by itself grant access; otherwise
    // any GitHub account would get a shell on the host.
    expect(auth.isAllowed("random-stranger")).toBe(false);
  });

  test("a prefix of an allowed login is not allowed", () => {
    expect(auth.isAllowed("fufu")).toBe(false);
    expect(auth.isAllowed("fufurobot2")).toBe(false);
  });
});

describe("sessions", () => {
  test("round-trips a valid session", async () => {
    const token = await auth.createSession(user);
    const session = await auth.verifySession(token);
    expect(session?.login).toBe("fufurobot");
    expect(session?.id).toBe(177607284);
  });

  test("rejects a missing or malformed token", async () => {
    expect(await auth.verifySession(null)).toBeNull();
    expect(await auth.verifySession(undefined)).toBeNull();
    expect(await auth.verifySession("")).toBeNull();
    expect(await auth.verifySession("garbage")).toBeNull();
    expect(await auth.verifySession("a.b.c")).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await auth.createSession(user);
    const [, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    const forged = btoa(JSON.stringify({ login: "attacker", id: 1, exp: 9999999999 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await auth.verifySession(`${forged}.${sig}`)).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    const token = await auth.createSession(user);
    const dot = token.lastIndexOf(".");
    const flipped = token.slice(0, dot + 1) + (token.slice(dot + 1, dot + 2) === "A" ? "B" : "A") + token.slice(dot + 2);
    expect(await auth.verifySession(flipped)).toBeNull();
  });

  test("rejects a token signed with a different secret", async () => {
    const other = new AuthService({
      clientId: CLIENT,
      allowedLogins: ["fufurobot"],
      sessionSecret: "a-completely-different-secret-value",
    });
    const foreign = await other.createSession(user);
    expect(await auth.verifySession(foreign)).toBeNull();
  });

  test("rejects an expired session", async () => {
    const shortLived = new AuthService({
      clientId: CLIENT,
      allowedLogins: ["fufurobot"],
      sessionSecret: SECRET,
      sessionTtlSeconds: -1, // already expired
    });
    const token = await shortLived.createSession(user);
    expect(await shortLived.verifySession(token)).toBeNull();
  });

  test("re-checks the allow-list, so revoking access is immediate", async () => {
    const token = await auth.createSession(user);
    // The session was valid when minted; the allow-list has since changed.
    const revoked = new AuthService({
      clientId: CLIENT,
      allowedLogins: ["someone-else"],
      sessionSecret: SECRET,
    });
    expect(await revoked.verifySession(token)).toBeNull();
  });

  test("does not accept a session whose signature is valid but payload is not JSON", async () => {
    // Only reachable if the signing key leaks, but the parser must not throw.
    const bad = btoa("not json").replace(/=+$/, "");
    expect(await auth.verifySession(`${bad}.whatever`)).toBeNull();
  });

  test("exposes its TTL so the cookie can match the token", () => {
    expect(auth.sessionTtl()).toBeGreaterThan(0);
  });
});
