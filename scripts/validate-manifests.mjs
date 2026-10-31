#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const directory = "infra/kubernetes";
const errors = [];
const resources = [];

const files = (await readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
for (const file of files) {
  const source = await readFile(join(directory, file), "utf8");
  for (const document of parseAllDocuments(source)) {
    if (document.errors.length > 0) {
      for (const error of document.errors) errors.push(`${file}: ${error.message}`);
      continue;
    }
    if (!document.toJS()) continue;
    const resource = document.toJS();
    if (!resource.apiVersion || !resource.kind || !resource.metadata?.name) {
      errors.push(`${file}: resource is missing apiVersion, kind or metadata.name`);
      continue;
    }
    resources.push({ file, ...resource });
  }
}

const namesOf = (kind) => new Set(resources.filter((item) => item.kind === kind).map((item) => item.metadata.name));
const configMaps = namesOf("ConfigMap");
const secrets = namesOf("Secret");
const workloads = resources.filter((item) => ["Deployment", "StatefulSet"].includes(item.kind));

for (const workload of workloads) {
  const spec = workload.spec?.template?.spec;
  const containers = [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])];
  for (const source of containers.flatMap((container) => container.envFrom ?? [])) {
    if (source.configMapRef && !configMaps.has(source.configMapRef.name)) {
      errors.push(`${workload.metadata.name}: missing ConfigMap ${source.configMapRef.name}`);
    }
    if (source.secretRef && !secrets.has(source.secretRef.name)) {
      errors.push(`${workload.metadata.name}: missing Secret ${source.secretRef.name}`);
    }
  }
  const podSecurity = spec?.securityContext ?? {};
  if (podSecurity.runAsNonRoot !== true) {
    errors.push(`${workload.metadata.name}: pod securityContext must set runAsNonRoot`);
  }
  if (podSecurity.seccompProfile?.type !== "RuntimeDefault") {
    errors.push(`${workload.metadata.name}: pod securityContext must use RuntimeDefault seccomp`);
  }
  for (const container of containers) {
    if (container.securityContext?.allowPrivilegeEscalation !== false) {
      errors.push(`${workload.metadata.name}/${container.name}: allowPrivilegeEscalation must be false`);
    }
    if (container.securityContext?.readOnlyRootFilesystem !== true) {
      errors.push(`${workload.metadata.name}/${container.name}: root filesystem must be read-only`);
    }
    if (!container.securityContext?.capabilities?.drop?.includes("ALL")) {
      errors.push(`${workload.metadata.name}/${container.name}: capabilities must drop ALL`);
    }
    if (!container.resources?.requests || !container.resources?.limits) {
      errors.push(`${workload.metadata.name}/${container.name}: resource requests and limits are required`);
    }
    if (!container.readinessProbe || !container.livenessProbe) {
      errors.push(`${workload.metadata.name}/${container.name}: readiness and liveness probes are required`);
    }
  }
}

for (const service of resources.filter((item) => item.kind === "Service")) {
  const selector = service.spec?.selector ?? {};
  const matches = workloads.some((workload) => {
    const labels = workload.spec?.template?.metadata?.labels ?? {};
    return Object.entries(selector).every(([key, value]) => labels[key] === value);
  });
  if (!matches) errors.push(`${service.metadata.name}: Service selector matches no workload`);
  for (const port of service.spec?.ports ?? []) {
    const targetMatches = workloads.some((workload) =>
      (workload.spec?.template?.spec?.containers ?? []).some((container) =>
        (container.ports ?? []).some((candidate) =>
          typeof port.targetPort === "string"
            ? candidate.name === port.targetPort
            : candidate.containerPort === port.targetPort,
        ),
      ),
    );
    if (!targetMatches) errors.push(`${service.metadata.name}: targetPort ${String(port.targetPort)} has no container port`);
  }
}

for (const hpa of resources.filter((item) => item.kind === "HorizontalPodAutoscaler")) {
  const target = hpa.spec?.scaleTargetRef;
  const exists = workloads.some(
    (workload) => workload.kind === target?.kind && workload.metadata.name === target?.name,
  );
  if (!exists) errors.push(`${hpa.metadata.name}: HPA target ${target?.kind}/${target?.name} not found`);
}

for (const policy of resources.filter((item) => item.kind === "NetworkPolicy")) {
  const selector = policy.spec?.podSelector?.matchLabels ?? {};
  if (Object.keys(selector).length > 0) {
    const matches = workloads.some((workload) => {
      const labels = workload.spec?.template?.metadata?.labels ?? {};
      return Object.entries(selector).every(([key, value]) => labels[key] === value);
    });
    if (!matches) errors.push(`${policy.metadata.name}: NetworkPolicy selector matches no workload`);
  }
}

for (const reference of resources.filter((item) => item.kind === "PodDisruptionBudget")) {
  const selector = reference.spec?.selector?.matchLabels ?? {};
  const matches = workloads.some((workload) => {
    const labels = workload.spec?.template?.metadata?.labels ?? {};
    return Object.entries(selector).every(([key, value]) => labels[key] === value);
  });
  if (!matches) errors.push(`${reference.metadata.name}: PodDisruptionBudget selector matches no workload`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`manifest error: ${error}\n`);
  process.exit(1);
}
process.stdout.write(`validated ${resources.length} Kubernetes resources in ${files.length} files\n`);
