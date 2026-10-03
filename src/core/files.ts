/**
 * File service — the filesystem API Project Mode is built on.
 *
 * All access is funnelled through the path sandbox so a malformed or hostile
 * request fails loudly instead of touching something outside the workspace.
 */
import { promises as fs } from "node:fs";
import { resolveInRoot, toRelative, isInsideRoot } from "./paths";

export type EntryKind = "file" | "directory";

export interface DirEntry {
  name: string;
  /** Root-relative, "/"-separated id. */
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
}

export interface FileStat {
  path: string;
  kind: EntryKind;
  size: number;
  mtime: number;
}

export interface ListOptions {
  showHidden?: boolean;
}

/** Directories that mark a project root. */
const PROJECT_MARKERS = [".git", "package.json", "Cargo.toml", "pyproject.toml", "bun.lockb"];

/** Never descend into these when scanning; they are large and derived. */
const SCAN_SKIP = new Set(["node_modules", ".git", "target", "dist", ".venv", "__pycache__"]);

export class FileService {
  constructor(private readonly root: string) {}

  /** Absolute, sandboxed path for a request-supplied relative id. */
  private abs(rel: string): string {
    return resolveInRoot(this.root, rel);
  }

  private id(absPath: string): string {
    return toRelative(this.root, absPath);
  }

  async read(rel: string): Promise<string> {
    try {
      return await fs.readFile(this.abs(rel), "utf8");
    } catch (err) {
      throw translateError(err, rel);
    }
  }

  async write(rel: string, contents: string): Promise<void> {
    if (typeof contents !== "string") {
      throw new TypeError("contents must be a string");
    }
    const target = this.abs(rel);
    try {
      // mkdir -p on the parent so nested writes just work.
      const parent = target.slice(0, Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")));
      if (parent) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    } catch (err) {
      throw translateError(err, rel);
    }
  }

  async list(rel: string, options: ListOptions = {}): Promise<DirEntry[]> {
    const dir = this.abs(rel);
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw translateError(err, rel);
    }

    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      if (!options.showHidden && dirent.name.startsWith(".")) continue;

      const absChild = `${dir}${sep(dirent.name)}`;
      // A symlink escaping the root must not be advertised as listable.
      if (!isInsideRoot(this.root, absChild)) continue;

      let kind: EntryKind = dirent.isDirectory() ? "directory" : "file";
      let size = 0;
      let mtime = 0;
      try {
        const st = await fs.stat(absChild);
        if (st.isDirectory()) kind = "directory";
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        // Racing deletion or a broken link: still surface the name.
      }
      entries.push({ name: dirent.name, path: this.id(absChild), kind, size, mtime });
    }

    // Directories first, then case-insensitive name order.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return entries;
  }

  async remove(rel: string): Promise<void> {
    const target = this.abs(rel);
    if (this.id(target) === "") {
      throw new Error("refusing to remove the workspace root");
    }
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err) {
      throw translateError(err, rel);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.abs(from);
    const dest = this.abs(to);
    if (this.id(src) === "") {
      throw new Error("refusing to rename the workspace root");
    }
    try {
      const parent = dest.slice(0, Math.max(dest.lastIndexOf("/"), dest.lastIndexOf("\\")));
      if (parent) await fs.mkdir(parent, { recursive: true });
      await fs.rename(src, dest);
    } catch (err) {
      throw translateError(err, from);
    }
  }

  async mkdir(rel: string): Promise<void> {
    try {
      await fs.mkdir(this.abs(rel), { recursive: true });
    } catch (err) {
      throw translateError(err, rel);
    }
  }

  async stat(rel: string): Promise<FileStat> {
    const target = this.abs(rel);
    try {
      const st = await fs.stat(target);
      return {
        path: this.id(target),
        kind: st.isDirectory() ? "directory" : "file",
        size: st.size,
        mtime: st.mtimeMs,
      };
    } catch (err) {
      throw translateError(err, rel);
    }
  }

  /**
   * Case-insensitive substring search over file paths.
   * Walks the sandbox only, and skips derived/vendored directories.
   */
  async search(query: string, limit = 200): Promise<string[]> {
    const needle = query.toLowerCase();
    const hits: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= limit) return;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable directory: skip rather than abort the search
      }
      for (const dirent of dirents) {
        if (hits.length >= limit) return;
        if (SCAN_SKIP.has(dirent.name)) continue;

        const absChild = `${dir}${sep(dirent.name)}`;
        if (!isInsideRoot(this.root, absChild)) continue;

        if (dirent.isDirectory()) {
          await walk(absChild);
        } else if (this.id(absChild).toLowerCase().includes(needle)) {
          hits.push(this.id(absChild));
        }
      }
    };

    await walk(this.root);
    return hits.sort();
  }

  /** Directories (root-relative) that look like independently openable projects. */
  async findProjectRoots(maxDepth = 3): Promise<string[]> {
    const roots: string[] = [];

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const names = new Set(dirents.map((d) => d.name));
      if (PROJECT_MARKERS.some((m) => names.has(m))) {
        roots.push(rel);
        return; // do not scan nested projects underneath one
      }

      for (const dirent of dirents) {
        if (!dirent.isDirectory() || SCAN_SKIP.has(dirent.name)) continue;
        const absChild = `${dir}${sep(dirent.name)}`;
        if (!isInsideRoot(this.root, absChild)) continue;
        await walk(absChild, this.id(absChild), depth + 1);
      }
    };

    await walk(this.root, "", 0);
    return roots;
  }

  /** Ensure the workspace root exists (called once at boot). */
  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }
}

function sep(name: string): string {
  return process.platform === "win32" ? `\\${name}` : `/${name}`;
}

/** Turn Node errno noise into messages an API client can act on. */
function translateError(err: unknown, rel: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new Error(`not found: ${rel}`);
  if (code === "EISDIR") return new Error(`is a directory: ${rel}`);
  if (code === "ENOTDIR") return new Error(`not a directory: ${rel}`);
  if (code === "EACCES" || code === "EPERM") return new Error(`permission denied: ${rel}`);
  return err instanceof Error ? err : new Error(String(err));
}
