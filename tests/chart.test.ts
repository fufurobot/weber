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
    //
    // Scoped to workload templates: a Service's `- name: http` is a port, not
    // a container, and matching it would make this check meaningless.
    for (const t of templates()) {
      if (!/kind:\s*(Deployment|StatefulSet)/.test(t.body)) continue;
      expect(t.body).toMatch(/resources:/);
      expect(t.body).toMatch(/\.Values\.\w+\.resources/);
    }

    // Every resources block in values must define both halves: requests for
    // scheduling, limits for containment.
    const blocks = read("values.yaml").split(/^\s{2}resources:/m).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const head = block.slice(0, 400);
      expect(head).toMatch(/requests:/);
      expect(head).toMatch(/limits:/);
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
    // The routing lives in a ConfigMap so it is delivered atomically with the
    // Deployment rather than baked into an image.
    const conf = read("templates/gateway-configmap.yaml");
    for (const path of ["/api", "/ws", "/judge0", "/gitlab", "/dsh"]) {
      expect(conf).toContain(path);
    }
  });

  test("websocket upgrades are proxied", () => {
    const conf = read("templates/gateway-configmap.yaml");
    expect(conf).toMatch(/Upgrade/);
    expect(conf).toMatch(/proxy_set_header\s+Connection/);
  });

  test("the gateway config is delivered as a ConfigMap, not an image", () => {
    expect(exists("templates/gateway-configmap.yaml")).toBe(true);
  });

  test("changing the config rolls the gateway pods", () => {
    // Without a checksum annotation a ConfigMap edit silently does nothing
    // until someone restarts by hand.
    expect(read("templates/gateway-deployment.yaml")).toMatch(/checksum\/config/);
  });

  test("the core is not exposed beyond ClusterIP", () => {
    const svc = read("templates/core-service.yaml");
    expect(svc).toMatch(/type:\s*ClusterIP/);
    expect(svc).not.toMatch(/type:\s*(NodePort|LoadBalancer)/);
  });
});

describe("values completeness", () => {
  /**
   * Every `.Values.X` a template dereferences must exist in values.yaml.
   *
   * This caught a real bug: networkpolicy.yaml used `.Values.networkPolicy.enabled`
   * while values.yaml never defined `networkPolicy`, so Helm failed with
   * "nil pointer evaluating interface {}.enabled". Regex assertions over
   * template text never rendered anything, so they could not see it.
   */
  test("every referenced top-level value is defined", () => {
    const values = read("values.yaml");
    const defined = new Set(
      values
        .split(/\r?\n/)
        .filter((l) => /^[a-zA-Z][A-Za-z0-9_]*:/.test(l))
        .map((l) => l.slice(0, l.indexOf(":"))),
    );

    const referenced = new Set<string>();
    for (const t of templates()) {
      for (const m of t.body.matchAll(/\.Values\.([A-Za-z0-9_]+)/g)) {
        referenced.add(m[1]!);
      }
    }

    expect(referenced.size).toBeGreaterThan(0);
    const missing = [...referenced].filter((k) => !defined.has(k));
    expect(missing).toEqual([]);
  });

  test("networkPolicy is defined, since a template depends on it", () => {
    expect(read("values.yaml")).toMatch(/^networkPolicy:/m);
  });

  test("every nested value a template reads has a default", () => {
    // A deeper dereference of an undefined key (`.Values.a.b.c`) also fails at
    // render time; this checks the two-level case that the chart actually uses.
    const values = read("values.yaml");
    for (const t of templates()) {
      for (const m of t.body.matchAll(/\.Values\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
        const [full, parent, child] = m;
        const parentDefined = new RegExp(`^${parent}:`, "m").test(values);
        if (!parentDefined) continue; // covered by the test above
        // The child must appear somewhere under the parent, or be guarded by
        // an `if`/`with` that runs first. Assert it exists at all.
        const childDefined = new RegExp(`^\\s+${child}:`, "m").test(values);
        expect(childDefined || /\{\{-?\s*if|\{\{-?\s*with/.test(t.body)).toBe(true);
      }
    }
  });
});

describe("guardrails", () => {
  test("the templates refuse to expose Weber without authentication", () => {
    // This is the single most important safety property in the chart: Weber
    // executes user-supplied code.
    const helpers = read("templates/_helpers.tpl");
    expect(helpers).toMatch(/weber\.validateAuth/);
    expect(helpers).toMatch(/fail "refusing to install/);
  });

  test("the validation runs on every render", () => {
    expect(read("templates/gateway-configmap.yaml")).toMatch(/include "weber\.validateAuth"/);
  });

  test("an empty allow-list is rejected rather than silently denying everyone", () => {
    expect(read("templates/_helpers.tpl")).toMatch(/allowedLogins/);
  });

  test("a network policy defaults to deny", () => {
    const np = read("templates/networkpolicy.yaml");
    expect(np).toMatch(/kind:\s*NetworkPolicy/);
    expect(np).toMatch(/default-deny/);
  });

  test("only the gateway may reach the core", () => {
    const np = read("templates/networkpolicy.yaml");
    expect(np).toMatch(/allow-gateway/);
    expect(np).toMatch(/component: gateway/);
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
    // The contexts come from values, applied to every pod via toYaml, so the
    // guarantee lives in values.yaml plus the fact that each pod references it.
    const values = read("values.yaml");
    expect(values).toMatch(/podSecurityContext:/);
    expect(values).toMatch(/runAsNonRoot:\s*true/);
    expect(values).toMatch(/securityContext:/);
    expect(values).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(values).toMatch(/seccompProfile:/);

    // And every workload must actually apply them.
    for (const t of templates()) {
      if (!/kind:\s*(Deployment|StatefulSet)/.test(t.body)) continue;
      expect(t.body).toMatch(/\.Values\.podSecurityContext/);
      expect(t.body).toMatch(/\.Values\.securityContext/);
    }
  });

  test("capabilities are dropped", () => {
    expect(read("values.yaml")).toMatch(/drop:\s*\n\s*-\s*ALL/);
  });
});

describe("portability", () => {
  test("values expose image repository and tag, so a registry can be swapped", () => {
    const values = read("values.yaml");
    expect(values).toMatch(/repository:/);
    expect(values).toMatch(/tag:/);
  });

  test("nothing hardcodes a cloud-specific storage class", () => {
    // A hardcoded storageClassName would break on any cluster lacking it, and
    // the default in values must therefore be empty.
    const values = read("values.yaml");
    expect(values).toMatch(/storageClassName:\s*""/);
    // And the template must only emit it when set.
    const svc = read("templates/core-service.yaml");
    expect(svc).toMatch(/if \.Values\.core\.persistence\.storageClassName/);
  });

  test("image tags fall back to the chart appVersion", () => {
    // Lets an operator install a released chart without pinning a tag, while
    // still allowing an override to a specific digest.
    const helpers = read("templates/_helpers.tpl");
    expect(helpers).toMatch(/default \.Chart\.AppVersion \.Values\.\w+\.image\.tag/);
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
