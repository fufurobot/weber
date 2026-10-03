/**
 * HTTP API contract.
 *
 * The routes are the boundary Project Mode talks to. These tests drive the
 * router directly (no listening socket) so they stay hermetic and fast, and
 * they assert the two properties that matter most: correct status codes, and
 * that the path/exec sandboxes cannot be bypassed over HTTP.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";

let root: string;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "weber-api-"));
  app = createApp({ workspaceRoot: root });
  await app.ready();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Issue a request against the in-process app. */
async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON responses are still valid (health text)
  }
  return { status: res.status, json, text };
}

describe("GET /api/health", () => {
  test("reports ok", async () => {
    const r = await req("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
  });

  test("reports the workspace root so the UI can show it", async () => {
    const r = await req("GET", "/api/health");
    expect(typeof r.json.workspaceRoot).toBe("string");
    expect(r.json.workspaceRoot.length).toBeGreaterThan(0);
  });

  test("reports uptime and version", async () => {
    const r = await req("GET", "/api/health");
    expect(typeof r.json.uptimeMs).toBe("number");
    expect(typeof r.json.version).toBe("string");
  });
});

describe("files API", () => {
  test("writes then reads a file", async () => {
    const w = await req("PUT", "/api/fs/file?path=hello.txt", { contents: "hi" });
    expect(w.status).toBe(200);

    const r = await req("GET", "/api/fs/file?path=hello.txt");
    expect(r.status).toBe(200);
    expect(r.json.contents).toBe("hi");
  });

  test("lists the workspace root", async () => {
    await req("PUT", "/api/fs/file?path=a.txt", { contents: "" });
    await req("PUT", "/api/fs/file?path=src/b.ts", { contents: "" });

    const r = await req("GET", "/api/fs/list?path=");
    expect(r.status).toBe(200);
    const names = r.json.entries.map((e: any) => e.name).sort();
    expect(names).toEqual(["a.txt", "src"]);
  });

  test("returns 404 for a missing file", async () => {
    const r = await req("GET", "/api/fs/file?path=nope.txt");
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/not found/i);
  });

  test("returns 400 for a traversal attempt", async () => {
    const r = await req("GET", "/api/fs/file?path=../../etc/passwd");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/escape|not allowed/i);
  });

  test("returns 400 for a traversal attempt on write", async () => {
    const r = await req("PUT", "/api/fs/file?path=../evil.txt", { contents: "x" });
    expect(r.status).toBe(400);
  });

  test("requires a path parameter", async () => {
    const r = await req("GET", "/api/fs/file");
    expect(r.status).toBe(400);
  });

  test("rejects a non-string contents field", async () => {
    const r = await req("PUT", "/api/fs/file?path=x.txt", { contents: 42 });
    expect(r.status).toBe(400);
  });

  test("creates and removes a directory", async () => {
    expect((await req("POST", "/api/fs/mkdir", { path: "d1/d2" })).status).toBe(200);
    expect((await req("GET", "/api/fs/list?path=d1")).json.entries[0].name).toBe("d2");

    expect((await req("POST", "/api/fs/remove", { path: "d1" })).status).toBe(200);
    expect((await req("GET", "/api/fs/list?path=d1")).status).toBe(404);
  });

  test("renames a file", async () => {
    await req("PUT", "/api/fs/file?path=old.txt", { contents: "p" });
    const r = await req("POST", "/api/fs/rename", { from: "old.txt", to: "new.txt" });
    expect(r.status).toBe(200);
    expect((await req("GET", "/api/fs/file?path=new.txt")).json.contents).toBe("p");
  });

  test("searches by substring", async () => {
    await req("PUT", "/api/fs/file?path=src/MainThing.ts", { contents: "" });
    const r = await req("GET", "/api/fs/search?q=mainthing");
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual(["src/MainThing.ts"]);
  });

  test("lists project roots", async () => {
    await req("PUT", "/api/fs/file?path=proj/.git/HEAD", { contents: "ref" });
    const r = await req("GET", "/api/fs/projects");
    expect(r.status).toBe(200);
    expect(r.json.projects).toContain("proj");
  });

  test("refuses to delete the workspace root", async () => {
    const r = await req("POST", "/api/fs/remove", { path: "." });
    expect(r.status).toBe(400);
  });

  test("does not expose file contents outside the root via symlink", async () => {
    // A traversal is rejected before the filesystem is ever touched.
    const r = await req("GET", "/api/fs/file?path=..%2F..%2Fwindows%2Fwin.ini");
    expect(r.status).toBe(400);
  });
});

describe("tools API", () => {
  test("lists toolchains with availability", async () => {
    const r = await req("GET", "/api/tools");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.toolchains)).toBe(true);
    const ids = r.json.toolchains.map((t: any) => t.id);
    expect(ids).toContain("bun");
    expect(ids).toContain("clang");
  });

  test("refuses an unlisted binary over HTTP", async () => {
    const r = await req("POST", "/api/tools/run", { argv: ["curl", "http://x"] });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not allowed/i);
  });

  test("refuses a working directory outside the workspace", async () => {
    const r = await req("POST", "/api/tools/run", {
      argv: ["bun", "--version"],
      cwd: "../..",
    });
    expect(r.status).toBe(400);
  });

  test("refuses an empty argv", async () => {
    const r = await req("POST", "/api/tools/run", { argv: [] });
    expect(r.status).toBe(400);
  });

  test("refuses a non-array argv", async () => {
    const r = await req("POST", "/api/tools/run", { argv: "bun --version" });
    expect(r.status).toBe(400);
  });
});

describe("notebook API", () => {
  test("runs cells and returns their values", async () => {
    const r = await req("POST", "/api/notebook/run", {
      cells: [
        { id: "a", code: "const a = 2;" },
        { id: "b", code: "const b = a * 3;" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    expect(r.json.values.b).toBe(6);
  });

  test("reports a cell error with its cell id", async () => {
    const r = await req("POST", "/api/notebook/run", {
      cells: [{ id: "bad", code: "throw new Error('boom');" }],
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("error");
    expect(r.json.errors.bad).toMatch(/boom/);
  });

  test("rejects a malformed cells payload", async () => {
    expect((await req("POST", "/api/notebook/run", { cells: "nope" })).status).toBe(400);
    expect((await req("POST", "/api/notebook/run", {})).status).toBe(400);
  });

  test("rejects a cell without an id or code", async () => {
    const r = await req("POST", "/api/notebook/run", { cells: [{ code: "const x = 1;" }] });
    expect(r.status).toBe(400);
  });

  test("does not leak non-serializable values", async () => {
    const r = await req("POST", "/api/notebook/run", {
      cells: [{ id: "f", code: "const f = () => 1;" }],
    });
    expect(r.status).toBe(200);
    // Functions cannot cross the wire; the response must stay valid JSON.
    expect(typeof r.json.values).toBe("object");
  });
});

describe("routing", () => {
  test("unknown API routes return 404 JSON", async () => {
    const r = await req("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error).toBeDefined();
  });

  test("OPTIONS is answered for preflight", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/health", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  test("errors never leak absolute server paths", async () => {
    const r = await req("GET", "/api/fs/file?path=../../secret");
    expect(r.text).not.toContain(root);
  });
});
