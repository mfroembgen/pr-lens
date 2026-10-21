import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const chart = fileURLToPath(new URL("..", import.meta.url));

const render = (...settings: string[]) => {
  const result = spawnSync("helm", ["template", "test", chart, ...settings.flatMap((value) => ["--set", value])], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.split(/^---\s*$/m).filter((value) => value.trim()).map((value) => Bun.YAML.parse(value));
};

test("keeps SQLite on a retained claim with one restricted writer", () => {
  const resources = render();
  const deployment = resources.find((value) => value.kind === "Deployment");
  const pvc = resources.find((value) => value.kind === "PersistentVolumeClaim");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  expect(deployment.spec.replicas).toBe(1);
  expect(deployment.spec.strategy.type).toBe("Recreate");
  expect(pod.automountServiceAccountToken).toBe(false);
  expect(pod.securityContext.runAsUser).toBe(1000);
  expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
  expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
  expect(container.image).toBe("ghcr.io/mfroembgen/pr-lens:v0.1.4");
  expect(container.env.find((value) => value.name === "DATABASE_PATH").value).toBe("/data/pr-lens.sqlite");
  expect(container.env.find((value) => value.name === "PUBLISH_TOKEN").valueFrom.secretKeyRef.name).toBe("pr-lens");
  expect(pod.volumes.find((value) => value.name === "data").persistentVolumeClaim.claimName).toBe(pvc.metadata.name);
  expect(pvc.metadata.annotations["helm.sh/resource-policy"]).toBe("keep");
  const service = resources.find((value) => value.kind === "Service");
  expect(service.spec.selector).toEqual(deployment.spec.selector.matchLabels);
  expect(deployment.spec.template.metadata.labels).toMatchObject(service.spec.selector);
});

test("uses an existing claim without managing its lifecycle", () => {
  const resources = render("persistence.existingClaim=saved-canvases");
  expect(resources.some((value) => value.kind === "PersistentVolumeClaim")).toBe(false);
  const pod = resources.find((value) => value.kind === "Deployment").spec.template.spec;
  expect(pod.volumes.find((value) => value.name === "data").persistentVolumeClaim.claimName).toBe("saved-canvases");
});

test("renders disposable storage and explicit ingress and network isolation", () => {
  const resources = render("persistence.enabled=false", "ingress.enabled=true", "networkPolicy.enabled=true");
  expect(resources.some((value) => value.kind === "PersistentVolumeClaim")).toBe(false);
  const deployment = resources.find((value) => value.kind === "Deployment");
  expect(deployment.spec.template.spec.volumes.find((value) => value.name === "data").emptyDir.sizeLimit).toBe("1Gi");
  expect(resources.find((value) => value.kind === "Ingress").spec.rules[0].host).toBe("pr-lens.example.com");
  const policy = resources.find((value) => value.kind === "NetworkPolicy");
  expect(policy.spec.podSelector.matchLabels).toEqual(deployment.spec.selector.matchLabels);
  expect(policy.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  expect(policy.spec.egress).toEqual([]);
});
