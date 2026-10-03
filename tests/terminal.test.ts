/**
 * Terminal websocket protocol.
 *
 * Hermetic: the handlers are driven with a fake socket, so no listener or real
 * websocket is needed. These pin the frame contract and — more importantly —
 * that the terminal cannot be used to escape the exec policy.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecService } from "../src/core/exec";
import { attachTerminal } from "../src/server/terminal";

let root: string;
let handlers: ReturnType<typeof attachTerminal>;
let frames: any[];
let socket: { send(d: string): void; close(): void; data: { path: string } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "weber-term-"));
  handlers = attachTerminal(new ExecService(root), root);
  frames = [];
  socket = {
    data: { path: "/ws" },
    send(d: string) {
      frames.push(JSON.parse(d));
    },
    close() {},
  };
});

const run = (msg: unknown) => handlers.message(socket, JSON.stringify(msg));
const last = () => frames[frames.length - 1];
/** The most recent error frame, ignoring anything else on the wire. */
const lastError = () => [...frames].reverse().find((f) => f.type === "error");

describe("terminal handshake", () => {
  test("sends a ready frame naming the workspace", () => {
    handlers.open(socket);
    expect(frames[0].type).toBe("ready");
    expect(frames[0].workspaceRoot).toBe(root);
  });

  test("advertises the toolchains the client may run", () => {
    handlers.open(socket);
    expect(Array.isArray(frames[0].allowed)).toBe(true);
    expect(frames[0].allowed).toContain("bun");
  });

  test("answers ping with pong", async () => {
    await run({ type: "ping" });
    expect(last().type).toBe("pong");
  });
});

describe("terminal policy — enforced before any process runs", () => {
  test("rejects malformed JSON without crashing", async () => {
    await handlers.message(socket, "{not json");
    expect(last().type).toBe("error");
    expect(last().message).toMatch(/invalid JSON/i);
  });

  test("rejects an unknown frame type", async () => {
    await run({ type: "exec", argv: ["bun"] });
    expect(last().type).toBe("error");
  });

  test("rejects an empty or missing argv", async () => {
    await run({ type: "run", argv: [] });
    expect(last().type).toBe("error");
    await run({ type: "run" });
    expect(last().type).toBe("error");
  });

  test("rejects an over-long argv", async () => {
    await run({ type: "run", argv: Array(100).fill("bun") });
    expect(last().message).toMatch(/exceeds/);
  });

  test("rejects non-string argv entries", async () => {
    await run({ type: "run", argv: ["bun", 42] });
    expect(last().message).toMatch(/short strings/);
  });

  test("refuses an unlisted binary and never starts a process", async () => {
    await run({ type: "run", argv: ["curl", "http://example.com"], id: "t1" });
    // A refusal must not be preceded by a start frame.
    expect(frames.some((f) => f.type === "start")).toBe(false);
    const err = lastError();
    expect(err.message).toMatch(/not allowed/i);
    expect(err.id).toBe("t1");
  });

  test("refuses a cwd outside the workspace", async () => {
    await run({ type: "run", argv: ["bun", "--version"], cwd: "../../etc" });
    expect(last().type).toBe("error");
    expect(frames.some((f) => f.type === "start")).toBe(false);
  });

  test("echoes the caller's correlation id on refusal", async () => {
    await run({ type: "run", argv: [], id: "abc-123" });
    expect(last().id).toBe("abc-123");
  });
});
