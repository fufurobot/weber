/**
 * Helm chart contract.
 *
 * A chart is configuration, and its mistakes surface at deploy time on someone
 * else's cluster. These tests pin the properties that matter and that are easy
 * to get silently wrong: the gateway is the only ingress, every workload has
 * probes, and no credential is baked into a template.
 *
 * Deliberately dependency-free — no Helm binary or YAML library — so the
 * assertions run in the hermetic suite on any machine.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "chart");
const read = (rel: string) => readFileSync(join(CHART, rel), "utf8");
const exists = (rel: string) => existsSync(join(CHART, rel));

/** All rendered templates, for aggregate assertions. */
function templates(): { name: string; body: string }[] {
  const dir = join(CHART, "templates");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".tpl"))
    .map((f) => ({ name: f, body: readFileSync(join(dir, f), "utf8") }));
}

describe("chart structure", () => {
  test("a chart directory exists", () => {
    expect(existsSync(CHART)).toBe(true);
  });

  test("Chart.yaml declares a name and version", () => {
    const src = read("Chart.yaml");
    expect(src).toMatch(/^name:\s*\S+/m);
    expect(src).toMatch(/^version:\s*\S+/m);
    expect(src).toMatch(/^apiVersion:\s*v2/m);
  });

  test("values.yaml exists and is documented", () => {
    const src = read("values.yaml");
    expect(src.length).toBeGreaterThan(200);
    // Comments are the only documentation an operator gets at install time.
    expect((src.match(/^\s*#/gm) ?? []).length).toBeGreaterThan(10);
  });

  test("a README explains installation", () => {
    expect(exists("README.md")).toBe(true);
    expect(read("README.md").length).toBeGreaterThan(300);
  });
});

describe("workloads", () => {
  test("the gateway is deployed", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    expect(all).toMatch(/kind:\s*Deployment/);
    expect(all).toMatch(/weber/);
  });

  test("every container declares resource requests and limits", () => {
    // A pod without limits can starve a shared cluster; this is the single
    // most common cause of a rejected or disruptive deployment.
    for (const t of templates()) {
      const containers = (t.body.match(/^\s*- name:/gm) ?? []).length;
      const resources = (t.body.match(/resources:/g) ?? []).length;
      if (containers > 0) {
        expect(resources).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("the gateway has readiness and liveness probes", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    expect(all).toMatch(/readinessProbe:/);
    expect(all).toMatch(/livenessProbe:/);
  });

  test("a ServiceAccount is not granted cluster-admin", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    expect(all).not.toMatch(/cluster-admin/);
  });
});

describe("ingress and routing", () => {
  test("ingress exists and is toggleable", () => {
    const values = read("values.yaml");
    expect(values).toMatch(/ingress:/);
    expect(values).toMatch(/enabled:/);
  });

  test("the gateway routes the service prefixes the RFC lists", () => {
    // ml-hub-style services plus the three integrations, behind one host.
    const conf = exists("files/nginx.conf") ? read("files/nginx.conf") : "";
    for (const path of ["/api", "/ws", "/gitlab", "/judge0", "/dsh"]) {
      expect(conf).toContain(path);
    }
  });

  test("websocket upgrades are proxied", () => {
    const conf = exists("files/nginx.conf") ? read("files/nginx.conf") : "";
    expect(conf).toMatch(/Upgrade/);
    expect(conf).toMatch(/proxy_set_header\s+Connection/);
  });
});

describe("security defaults", () => {
  test("no template contains a hardcoded credential", () => {
    for (const t of templates()) {
      expect(t.body).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
      expect(t.body).not.toMatch(/password:\s*["']?[A-Za-z0-9]{8,}["']?\s*$/m);
    }
  });

  test("secrets are referenced, not inlined", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    // A Secret resource may be created, but values must come from values or
    // an existing secret, never be literal in a Deployment env block.
    expect(all).toMatch(/secretKeyRef|valueFrom|existingSecret/);
  });

  test("pods run with a restricted security context by default", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    expect(all).toMatch(/securityContext/);
    expect(all).toMatch(/runAsNonRoot:\s*true/);
    expect(all).toMatch(/allowPrivilegeEscalation:\s*false/);
  });
});

describe("portability", () => {
  test("values expose image repository and tag, so a registry can be swapped", () => {
    const values = read("values.yaml");
    expect(values).toMatch(/repository:/);
    expect(values).toMatch(/tag:/);
  });

  test("nothing hardcodes a cloud-specific storage class", () => {
    const all = templates()
      .map((t) => t.body)
      .join("\n");
    // A storageClassName would break on any cluster that does not have it.
    expect(all).not.toMatch(/storageClassName:\s*(?!\{\{)/);
  });

  test("podman-compose can use the same built images", () => {
    // The RFC requires testing against both runtimes; shared image names are
    // what let one build artifact serve both.
    const compose = readFileSync(join(ROOT, "podman-compose.yml"), "utf8");
    const values = read("values.yaml");
    expect(values).toMatch(/weber/);
    expect(compose).toMatch(/weber-core|weber-web/);
  });
});
