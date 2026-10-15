// Εντοπισμός του Pod spec μέσα σε κάθε είδος Kubernetes workload.
const POD_TEMPLATE_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'];

class UnsupportedManifestError extends Error {}

function getPodSpec(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new UnsupportedManifestError('Manifest must be a JSON object');
  const { kind } = manifest;
  let spec;
  if (kind === 'Pod') spec = manifest.spec;
  else if (POD_TEMPLATE_KINDS.includes(kind)) spec = manifest.spec && manifest.spec.template && manifest.spec.template.spec;
  else if (kind === 'CronJob') spec = manifest.spec && manifest.spec.jobTemplate && manifest.spec.jobTemplate.spec
    && manifest.spec.jobTemplate.spec.template && manifest.spec.jobTemplate.spec.template.spec;
  else throw new UnsupportedManifestError(`Unsupported kind: ${kind || '(missing)'} — expected a Pod or a workload with a Pod template`);

  if (!spec || !Array.isArray(spec.containers) || spec.containers.length === 0) {
    throw new UnsupportedManifestError(`${kind} has no Pod spec with containers`);
  }
  return spec;
}

// Όλα τα containers (κανονικά και init) με τη διαδρομή τους, για αναφορά στο report.
function allContainers(spec) {
  const list = [];
  for (const group of ['initContainers', 'containers']) {
    (spec[group] || []).forEach((container, index) => list.push({ container, path: `spec.${group}[${index}]`, name: container.name }));
  }
  return list;
}

module.exports = { getPodSpec, allContainers, UnsupportedManifestError };
