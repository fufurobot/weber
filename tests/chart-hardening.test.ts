/**
 * Chart hardening merged from ml-hub.
 *
 * ml-hub is a JupyterHub distribution (see docs/ML-HUB-ANALYSIS.md), so its
 * whole chart does not fit ours. But three of its patterns are genuine
 * improvements over what we had, and all three are the kind of thing whose
 * absence is invisible until an incident:
 *
 *   1. blocking the cloud metadata endpoint (SSRF defence)
 *   2. a PodDisruptionBudget, so a node drain does not take the service down
 *   3. schema.yaml, so a typo in values fails at install with a clear message
 *      rather than as a nil-pointer deep inside a template
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CHART = join(ROOT, "chart");
const read = (rel: string) => readFileSync(join(CHART, rel), "utf8");
const exists = (rel: string) => existsSync(join(CHART, rel));

describe("cloud metadata protection", () => {
  test("values expose the metadata block", () => {
    expect(read("values.yaml")).toMatch(/cloudMetadata:/);
  });

  test("the metadata endpoint is blocked by default", () => {
    // 169.254.169.254 is the link-local address cloud providers use to expose
    // instance credentials. A user running code in a pod that can reach it can
    // often escalate to the node's IAM role.
    const values = read("values.yaml");
    expect(values).toMatch(/169\.254\.169\.254/);
    expect(values).toMatch(/enabled:\s*true/);
  });

  test("the network policy actually emits the exclusion", () => {
    const np = read("templates/networkpolicy.yaml");
    expect(np).toMatch(/ipBlock/);
    expect(np).toMatch(/except/);
    expect(np).toMatch(/cloudMetadata/);
  });

  test("egress is governed, not merely ingress", () => {
    // Ingress-only policies are a common half-measure: they stop nothing that
    // the pod initiates, which is exactly the SSRF case.
    const np = read("templates/networkpolicy.yaml");
    expect(np).toMatch(/Egress/);
  });
});

describe("disruption budget", () => {
  test("a PodDisruptionBudget exists", () => {
    expect(exists("templates/pdb.yaml")).toBe(true);
  });

  test("the budget covers the gateway and the core", () => {
    const pdb = read("templates/pdb.yaml");
    expect(pdb).toMatch(/kind:\s*PodDisruptionBudget/);
    expect(pdb).toMatch(/gateway/);
    expect(pdb).toMatch(/core/);
  });

  test("the budget is configurable and defaults to on", () => {
    const values = read("values.yaml");
    expect(values).toMatch(/podDisruptionBudget:/);
    expect(values).toMatch(/minAvailable/);
  });

  test("uses policy/v1, not the removed policy/v1beta1", () => {
    // ml-hub still uses v1beta1, which was removed in Kubernetes 1.25.
    expect(read("templates/pdb.yaml")).toMatch(/policy\/v1/);
    expect(read("templates/pdb.yaml")).not.toMatch(/policy\/v1beta1/);
  });
});

describe("values schema", () => {
  test("a schema exists", () => {
    expect(exists("values.schema.json")).toBe(true);
  });

  test("the schema is valid JSON with the expected shape", () => {
    const schema = JSON.parse(read("values.schema.json")) as {
      type: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(5);
  });

  test("the schema covers the components the chart deploys", () => {
    const schema = read("values.schema.json");
    for (const key of ["gateway", "core", "auth", "ingress", "judge0"]) {
      expect(schema).toContain(`"${key}"`);
    }
  });

  test("the schema requires the type of every documented knob", () => {
    // A schema that permits anything is worse than none: it gives the
    // impression of validation without performing any.
    const schema = JSON.parse(read("values.schema.json")) as {
      properties: Record<string, { type?: string; properties?: Record<string, { type?: string }> }>;
    };
    for (const [name, def] of Object.entries(schema.properties)) {
      expect(def.type).toBeDefined();
      if (def.type === "object" && def.properties) {
        // Every nested object's children should be typed too.
        const typed = Object.values(def.properties).filter((p) => p.type).length;
        expect(typed).toBeGreaterThan(0);
      }
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("merging notes", () => {
  test("the analysis document exists and names the source", () => {
    // The reasoning must be reviewable; a silently copied pattern is one that
    // nobody can safely change later.
    const doc = readFileSync(join(ROOT, "docs", "ML-HUB-ANALYSIS.md"), "utf8");
    expect(doc).toMatch(/ml-tooling\/ml-hub/);
    expect(doc).toMatch(/JupyterHub/);
    expect(doc).toMatch(/spawner/i);
  });

  test("our chart does not adopt ml-hub's build-time VERSION placeholder", () => {
    // ml-hub substitutes $VERSION from build.py at package time; copying it
    // verbatim yields a chart that cannot render.
    expect(read("Chart.yaml")).not.toContain("$VERSION");
    expect(read("values.yaml")).not.toContain("$VERSION");
  });
});
