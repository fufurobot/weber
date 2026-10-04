/**
 * Core service entrypoint.
 *
 * Serves the HTTP API and a terminal websocket. Configuration comes entirely
 * from the environment so the same image works in compose and standalone.
 */
import { createApp } from "./app";
import { attachTerminal } from "./terminal";
import { seedStarterWorkspace } from "../core/seed";

const host = process.env.CORE_HOST ?? "0.0.0.0";
const port = Number(process.env.CORE_PORT ?? 8787);
const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspaces";
const webOrigin = process.env.WEB_ORIGIN ?? "*";
const version = process.env.WEBER_VERSION ?? "0.1.0";
/** Set to 0 to boot an empty workspace (useful for tests and fresh images). */
const seedEnabled = process.env.WEBER_SEED !== "0";

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(`invalid CORE_PORT: ${process.env.CORE_PORT}`);
  process.exit(1);
}

const app = createApp({ workspaceRoot, webOrigin, version });
await app.ready();

// Give a first-time user something to open. This is a no-op on any workspace
// that already has content, so it is safe on every boot.
if (seedEnabled) {
  try {
    const seed = await seedStarterWorkspace(workspaceRoot);
    if (seed.seeded) {
      console.log(`seeded starter workspace with ${seed.written.length} file(s)`);
    }
  } catch (err) {
    // A read-only or unwritable workspace must not stop the service: the IDE
    // is still usable, it just opens empty.
    console.error("could not seed the starter workspace:", err);
  }
}

// Bound before the server so the handlers exist when the first client connects.
const terminalHandlers = attachTerminal(app.exec, workspaceRoot);

const server = Bun.serve({
  hostname: host,
  port,
  // The edge terminates client connections; this server only needs to handle
  // proxied requests, so keep it on HTTP/1.1 for simple upgrade semantics.
  fetch(request, srv) {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      const ok = srv.upgrade(request, { data: { path: url.pathname } });
      if (ok) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    return app.fetch(request);
  },
  websocket: terminalHandlers,
  error(err) {
    console.error("unhandled server error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  },
});

console.log(
  `weber core listening on http://${host}:${port} (workspace: ${workspaceRoot}, version: ${version})`,
);

/** Shut down cleanly so compose does not have to SIGKILL us. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, shutting down`);
    server.stop(true);
    process.exit(0);
  });
}
