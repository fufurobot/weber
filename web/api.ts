/**
 * API client.
 *
 * Always uses same-origin relative paths so the nginx edge can proxy /api to
 * the core service. A hardcoded host would break the moment the app is served
 * from anywhere other than the developer's machine.
 */

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
}

export interface FileResponse {
  path: string;
  contents: string;
  size: number;
  mtime: number;
}

export interface Toolchain {
  id: string;
  label: string;
  command: string[];
  binaries: string[];
  available: boolean;
  version?: string;
  error?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface NotebookCellPayload {
  id: string;
  code: string;
  kind?: "code" | "markdown";
}

export interface NotebookResult {
  status: "ok" | "error";
  executed: string[];
  skipped: string[];
  errors: Record<string, string>;
  values: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body is still worth surfacing verbatim.
  }

  if (!res.ok) {
    throw new ApiError(body?.error ?? `request failed (${res.status})`, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string; workspaceRoot: string; version: string }>("/api/health"),

  list: (path: string, hidden = false) =>
    request<{ entries: DirEntry[] }>(
      `/api/fs/list?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`,
    ).then((r) => r.entries),

  read: (path: string) =>
    request<FileResponse>(`/api/fs/file?path=${encodeURIComponent(path)}`),

  write: (path: string, contents: string) =>
    request<{ ok: true }>(`/api/fs/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({ contents }),
    }),

  mkdir: (path: string) =>
    request<{ ok: true }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ path }) }),

  remove: (path: string) =>
    request<{ ok: true }>("/api/fs/remove", { method: "POST", body: JSON.stringify({ path }) }),

  rename: (from: string, to: string) =>
    request<{ ok: true }>("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),

  search: (q: string) =>
    request<{ results: string[] }>(`/api/fs/search?q=${encodeURIComponent(q)}`).then(
      (r) => r.results,
    ),

  projects: () => request<{ projects: string[] }>("/api/fs/projects").then((r) => r.projects),

  tools: () => request<{ toolchains: Toolchain[] }>("/api/tools").then((r) => r.toolchains),

  run: (argv: string[], cwd?: string) =>
    request<RunResult>("/api/tools/run", {
      method: "POST",
      body: JSON.stringify({ argv, cwd }),
    }),

  notebook: (cells: NotebookCellPayload[]) =>
    request<NotebookResult>("/api/notebook/run", {
      method: "POST",
      body: JSON.stringify({ cells }),
    }),
};
