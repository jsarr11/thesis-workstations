const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createCluster, parseKubeBench, psaStatus, kubeBenchJob } = require('../src/cluster');
const { createServer } = require('../src/server');
const { evaluate } = require('../src/engine');

// Δείγμα εξόδου του kube-bench --json (ίδια δομή με την πραγματική)
const KUBE_BENCH_OUTPUT = JSON.stringify({
  Controls: [{
    id: '4', version: 'k3s-cis-1.8', detected_version: '1.26', text: 'Worker Node Security Configuration', node_type: 'node',
    tests: [{
      section: '4.1', desc: 'Worker Node Configuration Files',
      results: [
        { test_number: '4.1.1', test_desc: 'Ensure that the kubelet service file permissions are set to 600', status: 'PASS', scored: true },
        { test_number: '4.1.2', test_desc: 'Ensure that the kubelet service file ownership is set to root:root', status: 'FAIL', scored: true, remediation: 'chown root:root ...' },
        { test_number: '4.1.3', test_desc: 'If proxy kubeconfig file exists ensure permissions are set to 600', status: 'WARN', scored: false, remediation: 'chmod 600 ...' },
      ],
    }],
    total_pass: 1, total_fail: 1, total_warn: 1, total_info: 0,
  }],
  Totals: { total_pass: 1, total_fail: 1, total_warn: 1, total_info: 0 },
});

const CLUSTER_CONFIG = {
  kubectl: 'kubectl', kubeconfig: '', namespaces: ['workstations'], scanNamespace: 'compliance-system',
  kubeBenchImage: 'docker.io/aquasec/kube-bench:v0.15.6', kubeBenchBenchmark: '', scanTimeoutSeconds: 5,
};

// Ψεύτικο kubectl: καταγράφει τις κλήσεις και απαντά όπως το πραγματικό
function fakeKubectl({ jobStatus = { succeeded: 1 }, namespaceLabels = { 'pod-security.kubernetes.io/enforce': 'baseline' }, namespaceExists = true } = {}) {
  const calls = [];
  const exec = (command, args, options, cb) => {
    const call = { args, input: '' };
    calls.push(call);
    const reply = () => {
      const [verb, kind] = args;
      if (verb === 'apply') return cb(null, 'configured', '');
      if (verb === 'get' && kind === 'job') return cb(null, JSON.stringify({ status: jobStatus }), '');
      if (verb === 'logs') return cb(null, KUBE_BENCH_OUTPUT, '');
      if (verb === 'delete') return cb(null, 'deleted', '');
      if (verb === 'get' && kind === 'namespace') {
        if (!namespaceExists) return cb(new Error('exit 1'), '', `Error from server (NotFound): namespaces "${args[2]}" not found`);
        return cb(null, JSON.stringify({ metadata: { name: args[2], labels: namespaceLabels } }), '');
      }
      return cb(new Error(`unexpected kubectl ${args.join(' ')}`), '', '');
    };
    setImmediate(reply);
    return { stdin: { end: (input) => { call.input = input; } } };
  };
  return { exec, calls };
}

test('parseKubeBench: totals, results and detected benchmark', () => {
  const parsed = parseKubeBench(`some log line\n${KUBE_BENCH_OUTPUT}`);
  assert.deepEqual(parsed.totals, { pass: 1, fail: 1, warn: 1, info: 0 });
  assert.equal(parsed.results.length, 3);
  assert.equal(parsed.results[1].status, 'FAIL');
  assert.ok(parsed.results[1].remediation);
  assert.equal(parsed.results[0].remediation, undefined, 'remediation only for non-PASS');
  assert.match(parsed.benchmark, /k3s-cis-1\.8/);
});

test('psaStatus: baseline/restricted enforce is compliant, privileged or missing is not', () => {
  assert.equal(psaStatus('ws', { metadata: { labels: { 'pod-security.kubernetes.io/enforce': 'baseline' } } }).compliant, true);
  assert.equal(psaStatus('ws', { metadata: { labels: { 'pod-security.kubernetes.io/enforce': 'restricted' } } }).compliant, true);
  assert.equal(psaStatus('ws', { metadata: { labels: { 'pod-security.kubernetes.io/enforce': 'privileged' } } }).compliant, false);
  assert.equal(psaStatus('ws', { metadata: {} }).compliant, false);
  assert.deepEqual(psaStatus('ws', null), { namespace: 'ws', exists: false, enforce: null, warn: null, audit: null, compliant: false });
});

test('kubeBenchJob: runs on the host with read-only mounts, including k3s paths', () => {
  const job = kubeBenchJob('kb', 'compliance-system', 'img:1', 'k3s-cis-1.8');
  const pod = job.spec.template.spec;
  assert.equal(pod.hostPID, true);
  assert.deepEqual(pod.containers[0].command, ['kube-bench', 'run', '--json', '--benchmark', 'k3s-cis-1.8']);
  assert.ok(pod.volumes.some((v) => v.hostPath.path === '/var/lib/rancher'));
  assert.ok(pod.containers[0].volumeMounts.every((m) => m.readOnly));
});

test('scan: creates the scan namespace and Job, reads results, checks PSA, deletes the Job', async () => {
  const fake = fakeKubectl();
  const report = await createCluster(CLUSTER_CONFIG, { exec: fake.exec }).scan({ trigger: 'SCHEDULED' });

  assert.equal(report.report_type, 'cluster-review');
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.trigger, 'SCHEDULED');
  assert.deepEqual(report.summary, { pass: 1, fail: 1, warn: 1, info: 0, psa_compliant: true });
  assert.equal(report.pod_security_admission[0].enforce, 'baseline');
  assert.equal(report.kube_bench.results.length, 3);
  assert.equal(report.iso.control, 'A.8.9');

  const applied = fake.calls.filter((c) => c.args[0] === 'apply').map((c) => JSON.parse(c.input));
  assert.equal(applied[0].kind, 'Namespace');
  assert.equal(applied[0].metadata.labels['pod-security.kubernetes.io/enforce'], 'privileged');
  assert.equal(applied[1].kind, 'Job');
  assert.ok(fake.calls.some((c) => c.args[0] === 'delete' && c.args[1] === 'job'), 'job is cleaned up');
});

test('scan: a failed kube-bench Job still produces a FAILED report (evidence), PSA still checked', async () => {
  const fake = fakeKubectl({ jobStatus: { failed: 1 }, namespaceExists: false });
  const report = await createCluster(CLUSTER_CONFIG, { exec: fake.exec }).scan({ trigger: 'MANUAL', requested_by: 'admin@example.com' });
  assert.equal(report.status, 'FAILED');
  assert.match(report.error, /kube-bench job failed/);
  assert.equal(report.summary.psa_compliant, false);
  assert.equal(report.pod_security_admission[0].exists, false);
  assert.equal(report.requested_by, 'admin@example.com');
  assert.ok(fake.calls.some((c) => c.args[0] === 'delete'), 'job is cleaned up on failure too');
});

test('server: /cluster/scan stores cluster-logs, and the next workspace report embeds it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cluster-test-'));
  const fake = fakeKubectl();
  const key = 'k'.repeat(40);
  const server = createServer({ host: '127.0.0.1', port: 0, apiKey: key, dataDir, cluster: CLUSTER_CONFIG },
    { cluster: createCluster(CLUSTER_CONFIG, { exec: fake.exec }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } });
  try {
    assert.equal((await (await call('/cluster/latest')).json()).scan_id, null);

    const scan = await (await call('/cluster/scan', { method: 'POST', body: JSON.stringify({ trigger: 'MANUAL', requested_by: 'admin@example.com' }) })).json();
    assert.equal(scan.status, 'COMPLETED');
    assert.equal(scan.summary.fail, 1);

    const bytes = Buffer.from(await (await call(`/cluster/reports/${scan.scan_id}`)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), scan.report_sha256);
    assert.equal((await (await call('/cluster/latest')).json()).scan_id, scan.scan_id);

    const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c', image: 'i' }] } };
    const evalRes = await (await call('/evaluate', { method: 'POST', body: JSON.stringify({ manifest: pod, rules: [{ id: 'A.8.9', enabled: true }] }) })).json();
    const report = JSON.parse(Buffer.from(await (await call(`/reports/${evalRes.report_id}`)).arrayBuffer()).toString('utf8'));
    assert.equal(report.cluster_review.available, true);
    assert.equal(report.cluster_review.scan_id, scan.scan_id);
    assert.equal(report.cluster_review.cluster_report_sha256, scan.report_sha256);
    assert.equal(report.cluster_review.kube_bench.results.length, 3);

    const logFile = fs.readdirSync(path.join(dataDir, 'logs'))[0];
    assert.ok(fs.readFileSync(path.join(dataDir, 'logs', logFile), 'utf8').includes('"type":"cluster-review"'));
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('workspace report says when no cluster review exists yet', () => {
  const { report } = evaluate({ manifest: { kind: 'Pod', metadata: { name: 'p' }, spec: { containers: [{ name: 'c' }] } }, rules: [] });
  assert.equal(report.cluster_review.available, false);
});
