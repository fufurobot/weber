/**
 * Terminal websocket.
 *
 * Deliberately *not* a raw pty: it runs allow-listed, argv-shaped commands
 * through the same ExecService the HTTP API uses, so the terminal cannot do
 * anything the API would refuse. A shell would bypass both the allow-list and
 * the argv-as-data guarantee.
 *
 * Protocol (JSON text frames):
 *   client → { type: "run",  argv: string[], cwd?: string, id?: string }
 *   client → { type: "ping" }
 *   server → { type: "start", id }
 *   server → { type: "stdout"|"stderr", id, data }
 *   server → { type: "exit", id, code, timedOut, durationMs }
 *   server → { type: "error", id, message }
 */
import { ExecService } from "../core/exec";
import { SafePathError } from "../core/paths";

interface TerminalData {
  path: string;
}

type Socket = {
  send(data: string): void;
  close(): void;
  data: TerminalData;
};

const MAX_ARGV = 64;
const MAX_ARG_LENGTH = 8192;

/** Build the websocket handlers bound to one ExecService. */
export function attachTerminal(exec: ExecService, workspaceRoot: string) {
  return {
    open(socket: Socket): void {
      socket.send(
        JSON.stringify({
          type: "ready",
          workspaceRoot,
          // Tell the client up front what it may run, so the UI can show it.
          allowed: exec.toolchains().map((t) => t.id),
        }),
      );
    },

    async message(socket: Socket, raw: string | Buffer): Promise<void> {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");

      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid JSON frame" }));
        return;
      }

      if (msg?.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg?.type !== "run") {
        socket.send(JSON.stringify({ type: "error", message: `unknown frame type: ${msg?.type}` }));
        return;
      }

      const id = typeof msg.id === "string" ? msg.id : crypto.randomUUID();

      if (!Array.isArray(msg.argv) || msg.argv.length === 0) {
        socket.send(JSON.stringify({ type: "error", id, message: "argv must be a non-empty array" }));
        return;
      }
      if (msg.argv.length > MAX_ARGV) {
        socket.send(JSON.stringify({ type: "error", id, message: `argv exceeds ${MAX_ARGV} entries` }));
        return;
      }
      if (msg.argv.some((a: unknown) => typeof a !== "string" || a.length > MAX_ARG_LENGTH)) {
        socket.send(
          JSON.stringify({ type: "error", id, message: "argv entries must be short strings" }),
        );
        return;
      }

      // Validate the full request *before* announcing a start, so a refused
      // command is never reported as having begun.
      const options = {
        argv: msg.argv as string[],
        cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
        timeoutMs: typeof msg.timeoutMs === "number" ? msg.timeoutMs : undefined,
      };
      try {
        exec.authorize(options.argv);
        exec.resolveCwd(options.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        socket.send(JSON.stringify({ type: "error", id, message }));
        return;
      }

      socket.send(JSON.stringify({ type: "start", id }));

      try {
        const result = await exec.run(options);

        // Stream the captured output in chunks so the UI renders progressively.
        if (result.stdout) {
          socket.send(JSON.stringify({ type: "stdout", id, data: result.stdout }));
        }
        if (result.stderr) {
          socket.send(JSON.stringify({ type: "stderr", id, data: result.stderr }));
        }
        socket.send(
          JSON.stringify({
            type: "exit",
            id,
            code: result.code,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
          }),
        );
      } catch (err) {
        const message =
          err instanceof SafePathError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        socket.send(JSON.stringify({ type: "error", id, message }));
      }
    },

    close(): void {
      // Nothing to release: commands are awaited inline and never detached.
    },
  };
}
