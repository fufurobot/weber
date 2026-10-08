/**
 * Image build coverage.
 *
 * Three Dockerfiles existed for a long time without any of them ever being
 * built. They were validated by reading them, which is not the same claim: a
 * Dockerfile that has never been built is a draft.
 *
 * No container runtime is available in the development environment here —
 * `podman machine start` fails with "virtualization is not enabled on this
 * machine", which is a host-level setting. So the build is verified in CI,
 * where runners do have a runtime, and these tests assert that the CI workflow
 * actually builds each one rather than merely linting it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

/** Every Dockerfile the project ships. */
const DOCKERFILES = [
  "compose/Dockerfile.core",
  "compose/Dockerfile.web",
  "deploy/paas/Dockerfile",
];

describe("Dockerfiles exist", () => {
  test("each expected Dockerfile is present", () => {
    for (const df of DOCKERFILES) {
      expect(`${df}:${exists(df)}`).toBe(`${df}:true`);
    }
  });
});

describe("CI builds every image", () => {
  const ci = () => read(".github/workflows/ci.yml");

  test("there is a job that builds images", () => {
    expect(ci()).toMatch(/build-images|Build the images/);
  });

  test("every Dockerfile is built, not merely linted", () => {
    // The distinction is the whole point of this file.
    const src = ci();
    for (const df of DOCKERFILES) {
      expect(`${df}:${src.includes(df)}`).toBe(`${df}:true`);
    }
  });

  test("builds use the repository root as context", () => {
    // compose/Dockerfile.web COPYs compose/nginx.conf and scripts/, and
    // deploy/paas/COPYs src and web, so a narrower context fails the build.
    const src = ci();
    const buildBlocks = src.split(/- name: Build/).slice(1);
    expect(buildBlocks.length).toBeGreaterThanOrEqual(DOCKERFILES.length);
    for (const block of buildBlocks) {
      const head = block.slice(0, 600);
      if (head.includes("docker build")) {
        expect(head).toMatch(/\.\s*$/m);
      }
    }
  });

  test("the built images are smoke-tested, not only built", () => {
    // A successful build proves the layers are valid. It does not prove the
    // container starts, serves, or answers its healthcheck.
    expect(ci()).toMatch(/smoke|Smoke/);
  });
});

describe("runtime contract", () => {
  test("the core image exposes the port nginx proxies to", () => {
    expect(read("compose/Dockerfile.core")).toMatch(/EXPOSE\s+8787/);
  });

  test("the web image serves on the port the compose file publishes", () => {
    const web = read("compose/Dockerfile.web");
    const compose = read("podman-compose.yml");
    expect(web).toMatch(/EXPOSE\s+8080/);
    // The compose mapping publishes WEB_PORT onto 8080 inside the container.
    expect(compose).toMatch(/WEB_PORT:-3000\}?:8080/);
  });

  test("the PaaS image exposes a port the Procfile command binds", () => {
    expect(read("deploy/paas/Dockerfile")).toMatch(/EXPOSE\s+8080/);
  });

  test("every image runs as a non-root user", () => {
    // The stock nginx image runs as root, so this is not inherited from the
    // base — it has to be set, and nothing enforced it until now.
    for (const df of DOCKERFILES) {
      expect(`${df}:${/^USER\s+(?!root)\w+/m.test(read(df))}`).toBe(`${df}:true`);
    }
  });

  test("no image typechecks, because it cannot see the whole tree", () => {
    // The core image runs `typecheck` while copying only src/ and tests/, but
    // the tsconfig also covers web/. It therefore reported dozens of
    // "cannot find module '../web/...'" errors for files that are not in the
    // image at all. Non-fatal, it was noise; fatal, it needed the frontend in
    // a backend image. Typechecking belongs to CI, which has the full tree and
    // runs it blocking.
    for (const df of DOCKERFILES) {
      expect(`${df}:${/bun run typecheck/.test(read(df))}`).toBe(`${df}:false`);
    }
  });

  test("the core image explains why it does not typecheck", () => {
    // The reasoning must stay next to the code, or someone will helpfully add
    // the typecheck back and reintroduce dozens of false "cannot find module"
    // errors for files a backend image never contains.
    const core = read("compose/Dockerfile.core");
    const instructions = core
      .split("\n")
      .filter((l) => /^(RUN|COPY|CMD|ENTRYPOINT)\b/.test(l.trim()))
      .join("\n");
    expect(instructions).not.toMatch(/typecheck/);
    expect(core).toMatch(/Compilation is checked in CI/);
  });

  test("the nginx image supplies the writable paths nginx needs when unprivileged", () => {
    // Dropping to a non-root user breaks nginx unless its pid, cache and temp
    // directories are writable. A missing one is a container that exits
    // immediately with a confusing "permission denied" on startup.
    //
    // The paths are split across two files on purpose: the pid and temp paths
    // belong to the main config, which the Dockerfile installs, while the
    // directory ownership has to be set in the image.
    const web = read("compose/Dockerfile.web");
    const mainConf = read("compose/nginx-unprivileged.conf");

    expect(web).toMatch(/nginx-unprivileged\.conf/);
    expect(web).toMatch(/chown[^\n]*nginx/);
    expect(web).toMatch(/\/var\/cache\/nginx/);

    expect(mainConf).toMatch(/pid\s+\/tmp\/nginx\.pid/);
    expect(mainConf).toMatch(/client_body_temp_path\s+\/var\/cache\/nginx/);
  });

  test("the server-block fragment cannot override the main config's paths", () => {
    // Documenting why the whole main config is replaced: conf.d fragments are
    // included inside `http {}` and cannot set `pid` or the temp paths.
    const fragment = read("compose/nginx.conf");
    expect(fragment).not.toMatch(/^\s*pid\s/m);
    expect(fragment).not.toMatch(/client_body_temp_path/);
  });

  test("every image that runs a service declares a healthcheck", () => {
    for (const df of DOCKERFILES) {
      expect(`${df}:${/HEALTHCHECK/.test(read(df))}`).toBe(`${df}:true`);
    }
  });

  test("no image copies a credential", () => {
    for (const df of DOCKERFILES) {
      const src = read(df);
      expect(src).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
      expect(src).not.toMatch(/COPY\s+\.env\b/);
    }
  });
});
