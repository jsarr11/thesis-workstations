// ISO/IEC 27001:2022 A.8.9 Configuration management
// Ασφαλές πρότυπο ρυθμίσεων (baseline) για τα Pods: CIS Kubernetes Benchmark v1.8, §5.2 (Pod Security Standards).
// Ο κανόνας κρατά τις συστάσεις που αφορούν την απομόνωση του Pod από τον host. Τα 5.2.2, 5.2.8–5.2.10
// (privileged, capabilities) ανήκουν στον A.8.2 και το 5.2.7 (root) στον A.8.28 (βλ. info/10-Rules-Application).
const { allContainers } = require('../workload');

// hostPID / hostIPC / hostNetwork: αν λείπουν ισχύει false (συμμορφούμενο). Διόρθωση: ρητό false.
function hostNamespaceCheck(id, field, title) {
  return {
    id,
    title,
    remediation: 'auto',
    evaluate(spec) {
      const actual = spec[field] === undefined ? null : spec[field];
      return [{
        target: `spec.${field}`,
        actual,
        expected: false,
        compliant: actual !== true,
        fix: () => { spec[field] = false; return false; },
      }];
    },
  };
}

module.exports = {
  id: 'A.8.9',
  title: 'Configuration management',
  iso: { standard: 'ISO/IEC 27001:2022', control: 'A.8.9', name: 'Configuration management' },
  source: 'CIS Kubernetes Benchmark v1.8, §5.2 Pod Security Standards',
  description: 'Configurations, including security configurations, of hardware, software, services and networks shall be established, documented, implemented, monitored and reviewed.',
  checks: [
    hostNamespaceCheck('CIS-5.2.3', 'hostPID', 'Minimize the admission of containers wishing to share the host process ID namespace'),
    hostNamespaceCheck('CIS-5.2.4', 'hostIPC', 'Minimize the admission of containers wishing to share the host IPC namespace'),
    hostNamespaceCheck('CIS-5.2.5', 'hostNetwork', 'Minimize the admission of containers wishing to share the host network namespace'),

    {
      id: 'CIS-5.2.6',
      title: 'Minimize the admission of containers with allowPrivilegeEscalation',
      remediation: 'auto',
      // Αν λείπει, το Kubernetes επιτρέπει privilege escalation (π.χ. sudo), άρα απαιτείται ρητό false.
      evaluate(spec) {
        return allContainers(spec).map(({ container, path }) => {
          const sc = container.securityContext || {};
          const actual = sc.allowPrivilegeEscalation === undefined ? null : sc.allowPrivilegeEscalation;
          const finding = {
            target: `${path}.securityContext.allowPrivilegeEscalation`,
            container: container.name,
            actual,
            expected: false,
            compliant: actual === false,
          };
          if (sc.privileged === true) {
            // Το Kubernetes απορρίπτει privileged: true μαζί με allowPrivilegeEscalation: false.
            finding.reason = 'Container is privileged; privileged containers are handled by rule A.8.2 (CIS 5.2.2)';
          } else {
            finding.fix = () => {
              container.securityContext = { ...container.securityContext, allowPrivilegeEscalation: false };
              return false;
            };
          }
          return finding;
        });
      },
    },

    {
      id: 'CIS-5.2.12',
      title: 'Minimize the admission of HostPath volumes',
      remediation: 'block',
      // Η αφαίρεση ενός volume θα χαλούσε το Pod, οπότε η παράβαση μπλοκάρει το deployment.
      evaluate(spec) {
        const volumes = spec.volumes || [];
        const hostPaths = volumes.map((v, i) => ({ v, i })).filter(({ v }) => v.hostPath);
        if (hostPaths.length === 0) return [{ target: 'spec.volumes[*].hostPath', actual: null, expected: null, compliant: true }];
        return hostPaths.map(({ v, i }) => ({
          target: `spec.volumes[${i}].hostPath`,
          volume: v.name,
          actual: v.hostPath.path || v.hostPath,
          expected: null,
          compliant: false,
          reason: 'HostPath volumes expose the node filesystem; remove the volume or use a non-host volume type',
        }));
      },
    },

    {
      id: 'CIS-5.2.13',
      title: 'Minimize the admission of containers which use HostPorts',
      remediation: 'block',
      evaluate(spec) {
        const findings = [];
        for (const { container, path } of allContainers(spec)) {
          (container.ports || []).forEach((port, i) => {
            if (port.hostPort) {
              findings.push({
                target: `${path}.ports[${i}].hostPort`,
                container: container.name,
                actual: port.hostPort,
                expected: null,
                compliant: false,
                reason: 'HostPorts bind directly to the node network; expose the workload through a Service instead',
              });
            }
          });
        }
        return findings.length ? findings : [{ target: 'spec.containers[*].ports[*].hostPort', actual: null, expected: null, compliant: true }];
      },
    },
  ],
};
