// ISO/IEC 27001:2022 A.8.28 Secure coding
// Το λογισμικό τρέχει χωρίς δικαιώματα root: CIS Kubernetes Benchmark v1.8, §5.2.7 (Minimize the admission of root containers).
// Ο κανόνας δεν ορίζει UID (runAsUser): το UID το δίνει το image της κάθε πλατφόρμας. Ζητά μόνο runAsNonRoot: true,
// οπότε το kubelet αρνείται να ξεκινήσει container που θα έτρεχε ως root (το image πρέπει να έχει αριθμητικό USER).
const { allContainers } = require('../workload');

module.exports = {
  id: 'A.8.28',
  title: 'Secure coding',
  iso: { standard: 'ISO/IEC 27001:2022', control: 'A.8.28', name: 'Secure coding' },
  source: 'CIS Kubernetes Benchmark v1.8, §5.2.7 Minimize the admission of root containers',
  description: 'Secure coding principles shall be applied to software development.',
  checks: [
    {
      id: 'CIS-5.2.7a',
      title: 'Containers must be required to run as a non-root user (runAsNonRoot: true)',
      remediation: 'auto',
      // Αν λείπει, το Kubernetes τρέχει το container με τον χρήστη του image, ακόμη και root. Διόρθωση: runAsNonRoot: true
      // στο Pod, ώστε να ισχύει για όλα τα containers. Αν όλα τα containers το έχουν ήδη, το Pod είναι συμμορφούμενο.
      evaluate(spec) {
        const podSc = spec.securityContext || {};
        const actual = podSc.runAsNonRoot === undefined ? null : podSc.runAsNonRoot;
        const allContainersSet = allContainers(spec)
          .every(({ container }) => (container.securityContext || {}).runAsNonRoot === true);
        const finding = {
          target: 'spec.securityContext.runAsNonRoot',
          actual,
          expected: true,
          compliant: actual === true || (actual === null && allContainersSet),
        };
        if (actual === false) {
          // Ρητή επιλογή του καλούντος: δεν την αλλάζουμε σιωπηλά, το deployment μπλοκάρεται.
          finding.reason = 'runAsNonRoot is explicitly set to false; set it to true or remove it';
        } else {
          finding.fix = () => {
            spec.securityContext = { ...spec.securityContext, runAsNonRoot: true };
            return true;
          };
        }
        return [finding];
      },
    },

    {
      id: 'CIS-5.2.7b',
      title: 'Minimize the admission of containers that explicitly run as root',
      remediation: 'block',
      // runAsUser: 0 (Pod ή container) ή runAsNonRoot: false σε container. Δεν διορθώνεται αυτόματα: το UID που θα
      // έπρεπε να μπει εξαρτάται από το image, οπότε το deployment μπλοκάρεται.
      evaluate(spec) {
        const findings = [];
        const podSc = spec.securityContext || {};
        if (podSc.runAsUser === 0) {
          findings.push({
            target: 'spec.securityContext.runAsUser',
            actual: 0,
            expected: null,
            compliant: false,
            reason: 'The Pod is set to run as root (UID 0); remove runAsUser or use a non-zero UID',
          });
        }
        for (const { container, path } of allContainers(spec)) {
          const sc = container.securityContext || {};
          if (sc.runAsUser === 0) {
            findings.push({
              target: `${path}.securityContext.runAsUser`,
              container: container.name,
              actual: 0,
              expected: null,
              compliant: false,
              reason: 'The container is set to run as root (UID 0); remove runAsUser or use a non-zero UID',
            });
          }
          if (sc.runAsNonRoot === false) {
            findings.push({
              target: `${path}.securityContext.runAsNonRoot`,
              container: container.name,
              actual: false,
              expected: true,
              compliant: false,
              reason: 'runAsNonRoot: false on the container overrides the Pod setting and allows root',
            });
          }
        }
        return findings.length ? findings : [{
          target: 'spec.securityContext.runAsUser, spec.containers[*].securityContext.runAsUser/runAsNonRoot',
          actual: null,
          expected: null,
          compliant: true,
        }];
      },
    },
  ],
};
