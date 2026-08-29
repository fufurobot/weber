# Weber

**A portable IDE that does TypeScript, Rust, C++ (clang+clangd+wasmchain), and Python (Pyodide) development everywhere.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## What is Weber?

Weber is a **portable, browser-based IDE** that brings a complete development environment to any device with a web browser. It combines the power of a full-featured IDE with the flexibility of reactive notebooks, giving you two distinct modes of work:

- **Project Mode** — A full IDE experience with file trees, terminals, Git integration, and the entire VS Code plugin ecosystem. Think of it as your development environment, accessible from anywhere.
- **Script Mode** — A reactive notebook experience inspired by [Observable HQ](https://observablehq.com/) and [Marimo](https://marimo.io/), where cells automatically react to changes, keeping your code and outputs in sync.

Whether you're writing Rust for WebAssembly, prototyping in Python with Pyodide, building TypeScript applications, or compiling C++ with clang and wasmchain — Weber runs it all.

---

## Why Weber?

| Problem | Weber's Solution |
|---------|------------------|
| Setting up dev environments is painful | Zero setup — just open a browser |
| Local IDEs are heavy and machine-bound | Portable — runs on any device, anywhere |
| Notebooks are great for exploration but weak for serious projects | **Project Mode** gives you a full IDE when you need it |
| IDEs are great for projects but overkill for quick experiments | **Script Mode** gives you reactive notebooks for rapid prototyping |
| Polyglot development requires juggling multiple tools | One IDE for TypeScript, Rust, C++, and Python |

---

## Features

### 🌐 Portable & Everywhere
- Runs entirely in your browser — no installation, no local dependencies
- Deployable on any web server with a single command
- Works on desktop, tablet, or even phone

### 🚀 Multi-Language Support
- **TypeScript/JavaScript** — Full language server support with Bun runtime
- **Rust** — `cargo` and `rustc` integration, WASM compilation target
- **C/C++** — `clang` + `clangd` with wasmchain for WebAssembly builds
- **Python** — [Pyodide](https://pyodide.org/) runs Python 3.x entirely in the browser

### 📦 VS Code Plugin Ecosystem
- Full compatibility with VS Code extensions
- Language Server Protocol (LSP) support for IntelliSense across all languages
- Install plugins directly from the built-in marketplace

### 🔄 Two Modes, One Tool

**Project Mode** — Full IDE:
- File tree explorer
- Integrated terminal
- Git version control
- VS Code plugin ecosystem
- Project-level configuration

**Script Mode** — Reactive Notebook:
- Cell-based editing with automatic reactivity
- Code and outputs stay in sync — change one cell, dependent cells auto-update
- Mix Markdown and code in the same notebook
- Export notebooks as standalone scripts or apps

### ⚡ Built on Bun
- Lightning-fast startup and execution
- Bun's native Shell (`bun:shell`) for running `cargo`, `clang`, and other build tools
- Built-in TypeScript support without extra configuration

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/weber.git
cd weber

# Install dependencies
bun install

# Start the development server
bun run dev

# Build for production
bun run build
```

Then open `http://localhost:3000` in your browser.

### Deploy Anywhere

Weber is just static files + a Bun backend. Deploy it on:

- Any static web server (nginx, Apache, etc.)
- Cloud platforms (Vercel, Netlify, Cloudflare Pages)
- Self-hosted on your own infrastructure
- Even on a Raspberry Pi — it's that lightweight

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                             │
│  ┌─────────────────┐  ┌──────────────────────────────────┐  │
│  │   Project Mode   │  │         Script Mode             │  │
│  │  (VS Code-like)  │  │    (Reactive Notebook)          │  │
│  └────────┬────────┘  └───────────────┬──────────────────┘  │
│           │                            │                     │
│           └────────────┬───────────────┘                     │
│                        │                                     │
│              ┌─────────▼─────────┐                          │
│              │   Monaco Editor   │                          │
│              │   (VS Code core)  │                          │
│              └─────────┬─────────┘                          │
└────────────────────────┼────────────────────────────────────┘
                         │ WebSocket / HTTP
┌────────────────────────▼────────────────────────────────────┐
│                      Bun Backend                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Language    │  │   Build      │  │   AI Completion  │  │
│  │  Servers     │  │   Runner     │  │   (Ollama/OpenAI)│  │
│  │  (LSP)       │  │ (cargo/clang)│  └──────────────────┘  │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │  External Tools     │
              │  cargo · rustc      │
              │  clang · wasmchain  │
              │  Pyodide (WASM)     │
              └─────────────────────┘
```

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| **Runtime** | Bun |
| **Frontend** | React + shadcn/ui |
| **Editor Core** | Monaco Editor (VS Code's editor) |
| **Backend** | Bun + WebSockets |
| **Python** | Pyodide (WebAssembly CPython) |
| **Rust** | cargo, rustc, wasm-pack |
| **C/C++** | clang, clangd, wasmchain |
| **AI** | Ollama (local) / OpenAI API |
| **License** | AGPL-3.0 |

---

## Related Work

Weber builds on the shoulders of giants and draws inspiration from:

- **[Observable HQ](https://observablehq.com/)** — Reactive JavaScript notebooks
- **[Marimo](https://marimo.io/)** — Reactive Python notebooks
- **[JupyterLite](https://github.com/jupyterlite/jupyterlite)** — JupyterLab in the browser
- **[Pyodide](https://pyodide.org/)** — Python in the browser via WebAssembly
- **[code-server](https://github.com/coder/code-server)** — VS Code in the browser
- **[PyIDE](https://github.com/onlylonly/pyide)** — Browser-based Python IDE with Pyodide

---

## License

Weber is released under the **GNU Affero General Public License v3.0** (AGPL-3.0).

This means:
- You can use, modify, and distribute Weber freely
- Any modifications you make and distribute must also be open-sourced under AGPL
- If you run Weber as a network service, you must make the source code available to your users

See the [LICENSE](LICENSE) file for full details.

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Areas where we especially need help:
- More language integrations
- Performance optimizations for the reactive notebook engine
- Plugin ecosystem expansion
- Documentation and tutorials

---

## Roadmap

- [ ] Full VS Code extension marketplace integration
- [ ] Collaborative editing (multiplayer)
- [ ] More language support (Go, Zig, etc.)
- [ ] Built-in AI pair programming
- [ ] Mobile-optimized interface
- [ ] Offline mode with Service Workers

---

**Weber: Code anywhere, deploy everywhere.**
