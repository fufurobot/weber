/**
 * Weber — application shell.
 *
 * Two modes over one backend:
 *   Project Mode — file tree, editor, toolchain status
 *   Script Mode  — the reactive notebook
 *
 * Dependency-free on purpose: the SPA must build inside the Bun-only core
 * image without a Node toolchain, and Monaco is loaded from the edge as a
 * static asset rather than bundled here.
 */
import { api, ApiError, type DirEntry, type Toolchain } from "./api";
import { NotebookView } from "./notebook";

type Mode = "project" | "script";

const state = {
  mode: "project" as Mode,
  cwd: "",
  currentFile: null as string | null,
  entries: [] as DirEntry[],
  toolchains: [] as Toolchain[],
  dirty: false,
};

const root = document.getElementById("root")!;

/* ------------------------------------------------------------------ layout */

function shell(): void {
  root.innerHTML = "";

  const header = document.createElement("header");
  header.className = "app-header";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = "Weber";
  header.append(brand);

  const tabs = document.createElement("nav");
  tabs.className = "tabs";
  tabs.append(
    tabButton("Project Mode", "project"),
    tabButton("Script Mode", "script"),
  );
  header.append(tabs);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.id = "meta";
  header.append(meta);

  root.append(header);

  const main = document.createElement("main");
  main.className = "app-main";
  main.id = "main";
  root.append(main);
}

function tabButton(label: string, mode: Mode): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = `tab ${state.mode === mode ? "active" : ""}`;
  b.addEventListener("click", () => switchMode(mode));
  return b;
}

function switchMode(mode: Mode): void {
  if (state.mode === mode) return;
  if (state.mode === "project" && state.dirty) {
    // Never silently discard unsaved edits.
    if (!confirm("You have unsaved changes. Switch mode and discard them?")) return;
  }
  state.mode = mode;
  render();
}

function render(): void {
  shell();
  if (state.mode === "project") renderProject();
  else renderScript();
  void refreshMeta();
}

/* ------------------------------------------------------------ common chrome */

async function refreshMeta(): Promise<void> {
  const meta = document.getElementById("meta");
  if (!meta) return;
  try {
    const health = await api.health();
    meta.textContent = `v${health.version} · ${health.workspaceRoot}`;
    meta.title = health.workspaceRoot;
  } catch {
    meta.textContent = "backend unreachable";
  }
}

function main(): HTMLElement {
  return document.getElementById("main")!;
}

/* --------------------------------------------------------- project mode */

function renderProject(): void {
  const view = main();
  view.innerHTML = "";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.append(
    action("New file", () => void newFile()),
    action("New folder", () => void newFolder()),
    action("Refresh", () => void refreshTree()),
    action("↑ Up", () => {
      const parts = state.cwd.split("/").filter(Boolean);
      parts.pop();
      state.cwd = parts.join("/");
      void refreshTree();
    }),
  );
  sidebar.append(toolbar);

  const crumb = document.createElement("div");
  crumb.className = "crumbs";
  crumb.textContent = state.cwd === "" ? "/ (workspace root)" : `/${state.cwd}`;
  sidebar.append(crumb);

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search files…";
  search.className = "search";
  search.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = search.value.trim();
    if (!q) return void refreshTree();
    const results = await api.search(q).catch(() => []);
    state.entries = results.map((p) => ({
      name: p.split("/").pop() ?? p,
      path: p,
      kind: "file" as const,
      size: 0,
      mtime: 0,
    }));
    paintTree(tree);
  });
  sidebar.append(search);

  const tree = document.createElement("div");
  tree.className = "tree";
  sidebar.append(tree);

  const editorPane = document.createElement("section");
  editorPane.className = "editor-pane";

  const tools = document.createElement("div");
  tools.className = "tools";
  editorPane.append(tools);

  view.append(sidebar, editorPane);

  paintTree(tree);
  void refreshTree();
  void refreshTools(tools);
}

function paintTree(tree: HTMLElement): void {
  tree.innerHTML = "";
  if (state.entries.length === 0) {
    tree.append(node("div", "empty", "empty directory"));
    return;
  }
  for (const entry of state.entries) {
    const row = document.createElement("button");
    row.className = `tree-row ${entry.kind}`;
    row.textContent = `${entry.kind === "directory" ? "▸" : "·"} ${entry.name}`;
    row.title = entry.path;
    if (entry.kind === "directory") {
      row.addEventListener("click", () => {
        state.cwd = entry.path;
        void refreshTree();
      });
    } else {
      row.addEventListener("click", () => void openFile(entry.path));
    }
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void removeEntry(entry.path);
    });
    tree.append(row);
  }
}

async function refreshTree(): Promise<void> {
  const tree = document.querySelector<HTMLElement>(".tree");
  if (!tree) return;
  try {
    state.entries = await api.list(state.cwd);
  } catch (err) {
    state.entries = [];
    tree.innerHTML = "";
    tree.append(node("div", "empty", message(err)));
    return;
  }
  paintTree(tree);
}

async function openFile(path: string): Promise<void> {
  const pane = document.querySelector<HTMLElement>(".editor-pane");
  if (!pane) return;
  try {
    const file = await api.read(path);
    state.currentFile = path;
    state.dirty = false;

    pane.innerHTML = "";
    const head = node("div", "editor-head", path);
    const area = document.createElement("textarea");
    area.className = "editor";
    area.value = file.contents;
    area.spellcheck = false;
    area.addEventListener("input", () => {
      state.dirty = true;
      save.disabled = false;
    });

    const save = action("Save", async () => {
      if (!state.currentFile) return;
      try {
        await api.write(state.currentFile, area.value);
        state.dirty = false;
        save.textContent = "Saved";
        setTimeout(() => (save.textContent = "Save"), 1200);
      } catch (err) {
        alert(message(err));
      }
    });

    const bar = document.createElement("div");
    bar.className = "editor-bar";
    bar.append(action("Save", () => save.click()));
    pane.append(head, area, bar);
  } catch (err) {
    alert(message(err));
  }
}

async function newFile(): Promise<void> {
  const name = prompt("New file name");
  if (!name) return;
  const path = state.cwd ? `${state.cwd}/${name}` : name;
  await api.write(path, "").catch((e) => alert(message(e)));
  await refreshTree();
}

async function newFolder(): Promise<void> {
  const name = prompt("New folder name");
  if (!name) return;
  const path = state.cwd ? `${state.cwd}/${name}` : name;
  await api.mkdir(path).catch((e) => alert(message(e)));
  await refreshTree();
}

async function removeEntry(path: string): Promise<void> {
  if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
  await api.remove(path).catch((e) => alert(message(e)));
  if (state.currentFile === path) state.currentFile = null;
  await refreshTree();
}

async function refreshTools(host: HTMLElement): Promise<void> {
  try {
    state.toolchains = await api.tools();
  } catch {
    host.textContent = "toolchains unavailable";
    return;
  }
  host.innerHTML = "";
  host.append(node("div", "tools-title", "Toolchains"));
  for (const t of state.toolchains) {
    const chip = document.createElement("span");
    chip.className = `chip ${t.available ? "on" : "off"}`;
    chip.textContent = t.available ? `${t.id}` : `${t.id} (absent)`;
    chip.title = t.available ? (t.version ?? t.label) : (t.error ?? "not installed");
    host.append(chip);
  }
}

/* ---------------------------------------------------------- script mode */

function renderScript(): void {
  const view = main();
  view.innerHTML = "";
  const pane = document.createElement("section");
  pane.className = "notebook";
  view.append(pane);
  new NotebookView(pane);
}

/* ------------------------------------------------------------- utilities */

function node(tag: string, className = "", text = ""): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

function action(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "action";
  b.addEventListener("click", () => void onClick());
  return b;
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/* ---------------------------------------------------------------- startup */

render();
