/**
 * HTTP API.
 *
 * A single `fetch`-shaped handler so the same code serves the real server and
 * the tests (which call `app.fetch` directly, with no socket).
 *
 * Routes are thin: they translate HTTP into calls on the already-tested core
 * services and translate errors back into status codes. Policy lives in the
 * services, not here, so it cannot drift between the API and its tests.
 */
import { FileService } from "../core/files";
import { ExecService } from "../core/exec";
import { NotebookEngine, type Cell } from "../core/notebook/engine";
import { SafePathError } from "../core/paths";

export interface AppOptions {
  workspaceRoot: string;
  /** Public origin of the edge, used for CORS. */
  webOrigin?: string;
  version?: string;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  /** Ensure the workspace exists before serving traffic. */
  ready(): Promise<void>;
  readonly files: FileService;
  readonly exec: ExecService;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function createApp(options: AppOptions): App {
  const files = new FileService(options.workspaceRoot);
  const exec = new ExecService(options.workspaceRoot);
  const startedAt = Date.now();
  const version = options.version ?? "0.1.0";
  const webOrigin = options.webOrigin ?? "*";

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...JSON_HEADERS, ...corsHeaders(webOrigin) },
    });

  const fail = (status: number, error: string): Response => json({ error }, status);

  /** Map a thrown core error onto a status code. */
  const handleError = (err: unknown): Response => {
    if (err instanceof SafePathError) {
      // A path that tries to leave the sandbox is a bad request, not a 500.
      return fail(400, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/^not found/i.test(message)) return fail(404, message);
    if (/^is a directory|^not a directory|^permission denied/i.test(message)) {
      return fail(400, message);
    }
    if (/not allowed|must be|must not|empty/i.test(message)) return fail(400, message);
    // Log the cause so an unexpected failure is diagnosable, but never send
    // server internals (which may contain absolute paths) to the client.
    console.error("api error:", err);
    return fail(500, "internal error");
  };

  const handle = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // ---- health -----------------------------------------------------------
    if (path === "/api/health" && method === "GET") {
      return json({
        status: "ok",
        workspaceRoot: options.workspaceRoot,
        uptimeMs: Date.now() - startedAt,
        version,
      });
    }

    // ---- files ------------------------------------------------------------
    if (path === "/api/fs/list" && method === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      const showHidden = url.searchParams.get("hidden") === "1";
      return json({ entries: await files.list(rel, { showHidden }) });
    }

    if (path === "/api/fs/file" && method === "GET") {
      const rel = url.searchParams.get("path");
      if (rel === null) return fail(400, "path query parameter is required");
      const [contents, stat] = await Promise.all([files.read(rel), files.stat(rel)]);
      return json({ path: stat.path, contents, size: stat.size, mtime: stat.mtime });
    }

    if (path === "/api/fs/file" && method === "PUT") {
      const rel = url.searchParams.get("path");
      if (rel === null) return fail(400, "path query parameter is required");
      const body = await readJson(request);
      if (typeof body?.contents !== "string") {
        return fail(400, "body must be an object with a string 'contents' field");
      }
      await files.write(rel, body.contents);
      return json({ ok: true, path: rel });
    }

    if (path === "/api/fs/mkdir" && method === "POST") {
      const body = await readJson(request);
      if (typeof body?.path !== "string") return fail(400, "body must include a 'path' string");
      await files.mkdir(body.path);
      return json({ ok: true });
    }

    if (path === "/api/fs/remove" && method === "POST") {
      const body = await readJson(request);
      if (typeof body?.path !== "string") return fail(400, "body must include a 'path' string");
      // Deleting the whole workspace is never a legitimate request.
      if (isRootLike(body.path)) return fail(400, "refusing to remove the workspace root");
      await files.remove(body.path);
      return json({ ok: true });
    }

    if (path === "/api/fs/rename" && method === "POST") {
      const body = await readJson(request);
      if (typeof body?.from !== "string" || typeof body?.to !== "string") {
        return fail(400, "body must include 'from' and 'to' strings");
      }
      if (isRootLike(body.from)) return fail(400, "refusing to rename the workspace root");
      await files.rename(body.from, body.to);
      return json({ ok: true });
    }

    if (path === "/api/fs/stat" && method === "GET") {
      const rel = url.searchParams.get("path");
      if (rel === null) return fail(400, "path query parameter is required");
      return json(await files.stat(rel));
    }

    if (path === "/api/fs/search" && method === "GET") {
      const q = url.searchParams.get("q");
      if (q === null) return fail(400, "q query parameter is required");
      return json({ results: await files.search(q) });
    }

    if (path === "/api/fs/projects" && method === "GET") {
      return json({ projects: await files.findProjectRoots() });
    }

    // ---- tools ------------------------------------------------------------
    if (path === "/api/tools" && method === "GET") {
      const availability = await exec.probe();
      const toolchains = exec.toolchains().map((t) => ({
        ...t,
        ...availability[t.id],
      }));
      return json({ toolchains });
    }

    if (path === "/api/tools/run" && method === "POST") {
      const body = await readJson(request);
      if (!Array.isArray(body?.argv)) return fail(400, "body must include an 'argv' array");
      if (body.argv.some((a: unknown) => typeof a !== "string")) {
        return fail(400, "argv entries must be strings");
      }
      const result = await exec.run({
        argv: body.argv,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return json(result);
    }

    // ---- notebook ---------------------------------------------------------
    if (path === "/api/notebook/run" && method === "POST") {
      const body = await readJson(request);
      if (!Array.isArray(body?.cells)) return fail(400, "body must include a 'cells' array");
      for (const cell of body.cells) {
        if (!cell || typeof cell.id !== "string" || typeof cell.code !== "string") {
          return fail(400, "each cell must have a string 'id' and 'code'");
        }
      }

      const engine = new NotebookEngine();
      engine.setCells(body.cells as Cell[]);
      const result = await engine.run();

      return json({
        status: result.status,
        executed: result.executed,
        skipped: result.skipped,
        // Map -> plain object, and drop anything that cannot cross the wire.
        errors: Object.fromEntries(result.errors),
        values: serializableValues(engine),
      });
    }

    return fail(404, `no route for ${method} ${path}`);
  };

  return {
    files,
    exec,
    async ready() {
      await files.ensureRoot();
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // CORS: the SPA may be served from a different origin during development.
      if (request.method.toUpperCase() === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(webOrigin) });
      }

      try {
        return await handle(request, url);
      } catch (err) {
        return handleError(err);
      }
    },
  };
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
  };
}

/** Parse a JSON body, treating malformed input as an empty object. */
async function readJson(request: Request): Promise<any> {
  try {
    const text = await request.text();
    if (text.trim() === "") return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Paths that denote the workspace root itself. */
function isRootLike(p: string): boolean {
  const t = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return t === "" || t === "." || t === "/";
}

/**
 * Notebook values as JSON.
 *
 * Functions, symbols and cyclic structures cannot be serialized and must not
 * make the whole response fail, so they become a descriptive placeholder.
 */
function serializableValues(engine: NotebookEngine): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new WeakSet<object>();

  for (const [name, value] of engine.values) {
    out[name] = toJson(value, seen, 0);
  }
  return out;
}

function toJson(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
  if (t === "symbol") return "[Symbol]";
  if (t === "bigint") return `${value as bigint}n`;
  if (t !== "object") return value;

  // Bound the traversal: a notebook value may be a large or cyclic graph.
  if (depth > 8) return "[deep]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((v) => toJson(v, seen, depth + 1));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].slice(0, 1000).map(([k, v]) => [String(k), toJson(v, seen, depth + 1)]),
    );
  }
  if (value instanceof Set) {
    return [...value].slice(0, 1000).map((v) => toJson(v, seen, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toJson(v, seen, depth + 1);
  return out;
}
