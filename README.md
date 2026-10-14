# Weber

**A portable IDE that does TypeScript, Rust, C++ (clang+clangd+wasmchain), and Python (Pyodide) development everywhere.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/fufurobot/weber)

---

## What is Weber?

Weber is a **portable, browser-based IDE** that brings a complete development environment to any device with a web browser. It combines the power of a full-featured IDE with the flexibility of reactive notebooks, giving you two distinct modes of work:

- **Project Mode** — A full IDE experience with file trees, terminals, Git integration, and the entire VS Code plugin ecosystem. Think of it as your development environment, accessible from anywhere.
- **Notebook Mode** — A reactive notebook experience inspired by [Observable HQ](https://observablehq.com/) and [Marimo](https://marimo.io/), where cells automatically react to changes, keeping your code and outputs in sync. You can turn On/Off reactive mode as you wish. 
- **Script Mode** - A Plain IDE like LeetCode but under ACM mode to just run code. 

---

## Why Weber?

weber is an all in one solution that supports almost everything you can imagine. It is based on the helm chart of https://github.com/ml-tooling/ml-hub, but migrated to podman-compose.yml and apptainer for rootless deployment. 

## Features

- An unified multi-user system with OAuth to connect to any services. We integrate Github OAuth for easy access. 
- Built-in [SSH-proxy](https://github.com/ml-tooling/ssh-proxy) support: you can ssh to your remote VM any time you want.
- Runnable by apptainer: no tedious helm chart configuration
- Centralized self-hosted Gitlab Community Instance and Gitlab CI: your project is always properly managed
- An extra Judge0 Server for Script Mode
- A Port Panel for your machine that expose your port to host by HTTP(s) on `<FQDN>:<PORT>/<username>/vm/<vmid>/port/<expose-port>`, so you can share your work with others quickly
- An Coder server with Collarbrative editing plugin enabled for project mode
- Reactive kernel for Almost every language under Notebook mode: beyond observablehq and marimo
- A jhipster JDL designer and wizard to help you bootstrap your project quickly, without. 
- An llama.cpp/vllm/vllm-omni manager to help you manage deployed local GGUF/huggingface models. auto detect backend by checking *-smi commands on all pods.
- Deepseek Harness Web is properly configured with the llama.cpp/vllm manager per vm by default.
- Role based AAA system with users and groups
- [harbor](https://github.com/laude-institute/harbor) is also set for harness benchmarking on models in the manager. A [base dataset]
- MLFlow to manage experiment artifacts, embedded inside Notebook Mode.
- A hybrid object storage based on [OpenList](https://github.com/OpenListTeam/OpenList) which has been configured with Gitlab git LFS / Annex support, pod vm image storage, GGUF/huggingface models storage, huggingface dataset storage and MLFlow experiment storage, and every large sized things you can imagine


## License

[AGPL](./LICENSE). This means you need to provide source for any modified verision of this web service to users.


---

**Weber: Code anywhere, deploy everywhere.**
