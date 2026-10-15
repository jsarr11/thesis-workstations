// Επανεξέταση (review) του cluster για τον A.8.9: CIS scan με kube-bench και έλεγχος των labels του
// Pod Security Admission στα namespaces των workloads. Χρησιμοποιεί το kubectl (χωρίς εξωτερικές βιβλιοθήκες).
const crypto = require('crypto');
const { execFile } = require('child_process');
const { RULESET_VERSION } = require('./rules');
const { version: ENGINE_VERSION } = require('../package.json');

const PSA_PREFIX = 'pod-security.kubernetes.io/';
const PSA_ACCEPTED = ['baseline', 'restricted']; // το privileged (ή η απουσία label) δεν επιβάλλει τίποτα
const POLL_INTERVAL_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Μετατρέπει την έξοδο του kube-bench --json σε σύνοψη και λίστα αποτελεσμάτων.
function parseKubeBench(output) {
  const start = output.search(/[[{]/);
  if (start < 0) throw new Error('kube-bench produced no JSON output');
  const data = JSON.parse(output.slice(start));
  const controls = Array.isArray(data) ? data : (data.Controls || []);
  const sum = (field) => controls.reduce((n, c) => n + (Number(c[field]) || 0), 0);
  const totals = data.Totals
    ? { pass: data.Totals.total_pass, fail: data.Totals.total_fail, warn: data.Totals.total_warn, info: data.Totals.total_info }
    : { pass: sum('total_pass'), fail: sum('total_fail'), warn: sum('total_warn'), info: sum('total_info') };

  const results = [];
  for (const control of controls) {
    for (const group of control.tests || []) {
      for (const r of group.results || []) {
        results.push({
          id: r.test_number,
          section: `${group.section || ''} ${group.desc || ''}`.trim(),
          target: control.node_type || control.text || null,
          description: r.test_desc,
          status: r.status,
          scored: r.scored,
          ...(r.status !== 'PASS' && r.remediation ? { remediation: r.remediation } : {}),
          ...(r.reason ? { reason: r.reason } : {}),
        });
      }
    }
  }
  const first = controls[0] || {};
  return {
    benchmark: first.detected_version ? `${first.version || ''} (detected ${first.detected_version})`.trim() : (first.version || null),
    totals,
    results,
  };
}

// Κατάσταση του Pod Security Admission σε ένα namespace (από το JSON του kubectl get namespace).
function psaStatus(namespace, nsObject) {
  if (!nsObject) return { namespace, exists: false, enforce: null, warn: null, audit: null, compliant: false };
  const labels = (nsObject.metadata && nsObject.metadata.labels) || {};
  const enforce = labels[`${PSA_PREFIX}enforce`] || null;
  return {
    namespace,
    exists: true,
    enforce,
    warn: labels[`${PSA_PREFIX}warn`] || null,
    audit: labels[`${PSA_PREFIX}audit`] || null,
    compliant: PSA_ACCEPTED.includes(enforce),
  };
}

function scanNamespaceManifest(name) {
  // Το kube-bench χρειάζεται πρόσβαση στον host (hostPID, hostPath), άρα το δικό του namespace είναι privileged.
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name, labels: { 'pod-security.kubernetes.io/enforce': 'privileged', 'app.kubernetes.io/managed-by': 'compliance-engine' } },
  };
}

// Job του kube-bench (βάσει του job.yaml του kube-bench, με τους φακέλους του k3s).
function kubeBenchJob(name, namespace, image, benchmark) {
  const hostDirs = {
    'var-lib-etcd': '/var/lib/etcd',
    'var-lib-kubelet': '/var/lib/kubelet',
    'var-lib-kube-scheduler': '/var/lib/kube-scheduler',
    'var-lib-kube-controller-manager': '/var/lib/kube-controller-manager',
    'var-lib-rancher': '/var/lib/rancher',
    'etc-rancher': '/etc/rancher',
    'etc-systemd': '/etc/systemd',
    'lib-systemd': '/lib/systemd',
    'srv-kubernetes': '/srv/kubernetes',
    'etc-kubernetes': '/etc/kubernetes',
    'usr-bin': '/usr/bin',
    'etc-cni-netd': '/etc/cni/net.d',
    'opt-cni-bin': '/opt/cni/bin',
  };
  const mountPath = (key, dir) => (key === 'usr-bin' ? '/usr/local/mount-from-host/bin' : dir);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace, labels: { app: 'kube-bench', 'app.kubernetes.io/managed-by': 'compliance-engine' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { app: 'kube-bench' } },
        spec: {
          hostPID: true,
          restartPolicy: 'Never',
          containers: [{
            name: 'kube-bench',
            image,
            imagePullPolicy: 'IfNotPresent',
            command: ['kube-bench', 'run', '--json', ...(benchmark ? ['--benchmark', benchmark] : [])],
            volumeMounts: Object.entries(hostDirs).map(([key, dir]) => ({ name: key, mountPath: mountPath(key, dir), readOnly: true })),
          }],
          volumes: Object.entries(hostDirs).map(([key, dir]) => ({ name: key, hostPath: { path: dir } })),
        },
      },
    },
  };
}

function createCluster(config, { exec = execFile } = {}) {
  const [command, ...baseArgs] = config.kubectl.split(' ').filter(Boolean);

  function kubectl(args, { input, timeoutMs = 60000 } = {}) {
    const env = { ...process.env, ...(config.kubeconfig ? { KUBECONFIG: config.kubeconfig } : {}) };
    return new Promise((resolve, reject) => {
      const child = exec(command, [...baseArgs, ...args], { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            err.message = `kubectl ${args[0]} failed: ${(stderr || err.message).toString().trim()}`;
            return reject(err);
          }
          resolve(stdout.toString());
        });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  async function getNamespace(name) {
    try {
      return JSON.parse(await kubectl(['get', 'namespace', name, '-o', 'json']));
    } catch (err) {
      if (/NotFound|not found/i.test(err.message)) return null;
      throw err;
    }
  }

  async function runKubeBench() {
    const ns = config.scanNamespace;
    const jobName = `kube-bench-${crypto.randomBytes(4).toString('hex')}`;
    await kubectl(['apply', '-f', '-'], { input: JSON.stringify(scanNamespaceManifest(ns)) });
    await kubectl(['apply', '-f', '-'], { input: JSON.stringify(kubeBenchJob(jobName, ns, config.kubeBenchImage, config.kubeBenchBenchmark)) });
    try {
      const deadline = Date.now() + config.scanTimeoutSeconds * 1000;
      for (;;) {
        const job = JSON.parse(await kubectl(['get', 'job', jobName, '-n', ns, '-o', 'json']));
        const status = job.status || {};
        if (status.succeeded > 0) break;
        if (status.failed > 0) {
          const logs = await kubectl(['logs', `job/${jobName}`, '-n', ns]).catch(() => '');
          throw new Error(`kube-bench job failed${logs ? `: ${logs.trim().slice(-500)}` : ''}`);
        }
        if (Date.now() > deadline) throw new Error(`kube-bench did not finish within ${config.scanTimeoutSeconds}s (image pull or scheduling problem?)`);
        await sleep(POLL_INTERVAL_MS);
      }
      return parseKubeBench(await kubectl(['logs', `job/${jobName}`, '-n', ns]));
    } finally {
      await kubectl(['delete', 'job', jobName, '-n', ns, '--ignore-not-found', '--wait=false']).catch(() => {});
    }
  }

  // Πλήρες review: kube-bench + Pod Security Admission. Επιστρέφει πάντα report (και σε αποτυχία, ως αποδεικτικό).
  async function scan({ trigger = 'MANUAL', requested_by = null } = {}) {
    const startedAt = new Date().toISOString();
    let kubeBench = null;
    let error = null;
    try {
      kubeBench = await runKubeBench();
    } catch (err) {
      error = err.message;
    }

    let psa;
    try {
      psa = [];
      for (const name of config.namespaces) psa.push(psaStatus(name, await getNamespace(name)));
    } catch (err) {
      psa = config.namespaces.map((name) => ({ namespace: name, error: err.message, compliant: false }));
    }

    const status = kubeBench ? 'COMPLETED' : 'FAILED';
    return {
      report_type: 'cluster-review',
      schema_version: 1,
      scan_id: crypto.randomUUID(),
      started_at: startedAt,
      generated_at: new Date().toISOString(),
      engine: { name: 'compliance-engine', version: ENGINE_VERSION, ruleset_version: RULESET_VERSION },
      iso: {
        standard: 'ISO/IEC 27001:2022',
        control: 'A.8.9',
        name: 'Configuration management',
        requirement: 'Configurations shall be ... monitored and reviewed (periodic review of the cluster configuration)',
      },
      trigger,
      requested_by,
      status,
      ...(error ? { error } : {}),
      summary: {
        ...(kubeBench ? kubeBench.totals : { pass: null, fail: null, warn: null, info: null }),
        psa_compliant: psa.every((p) => p.compliant),
      },
      pod_security_admission: psa,
      kube_bench: kubeBench ? { image: config.kubeBenchImage, benchmark: kubeBench.benchmark, results: kubeBench.results } : { image: config.kubeBenchImage },
    };
  }

  return { scan };
}

module.exports = { createCluster, parseKubeBench, psaStatus, kubeBenchJob };
