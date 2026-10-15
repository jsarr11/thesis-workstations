const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine');

// Ίδιο σχήμα με το baseline manifest της πλατφόρμας των workstations
const basePod = () => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'workstation-test-0001', labels: { app: 'workstation-test-0001' } },
  spec: {
    containers: [{ name: 'workspace', image: 'workstation-profile:developer', ports: [{ containerPort: 3000 }] }],
    volumes: [{ name: 'workstation-token', secret: { secretName: 'workstation-test-0001-token' } }],
  },
});
const A89_ON = [{ id: 'A.8.9', enabled: true }];
const A89_OFF = [{ id: 'A.8.9', enabled: false, changed_by: 'admin@example.com', changed_at: '2026-10-15T10:00:00Z' }];
const check = (report, id) => report.rules[0].checks.filter((c) => c.check === id);

test('baseline Pod: A.8.9 ON remediates allowPrivilegeEscalation and allows deploy', () => {
  const input = basePod();
  const { report, manifest } = evaluate({ manifest: input, rules: A89_ON });

  assert.equal(report.decision, 'ALLOW');
  assert.equal(report.rules[0].outcome, 'REMEDIATED');
  assert.equal(manifest.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.equal(manifest.spec.hostPID, undefined, 'compliant fields are left untouched');
  assert.equal(check(report, 'CIS-5.2.6')[0].status, 'REMEDIATED');
  assert.equal(check(report, 'CIS-5.2.6')[0].before, null);
  assert.equal(check(report, 'CIS-5.2.6')[0].after, false);
  assert.equal(check(report, 'CIS-5.2.3')[0].status, 'PASS');
  assert.equal(report.summary.remediated, 1);
  assert.notEqual(report.manifest.sha256_before, report.manifest.sha256_after);
  assert.equal(input.spec.containers[0].securityContext, undefined, 'input manifest is not mutated');
});

test('baseline Pod: A.8.9 OFF leaves manifest unchanged and records the violation as not enforced', () => {
  const input = basePod();
  const { report, manifest } = evaluate({ manifest: input, rules: A89_OFF });

  assert.equal(report.decision, 'ALLOW');
  assert.deepEqual(manifest, input);
  assert.equal(report.rules[0].enabled, false);
  assert.equal(report.rules[0].outcome, 'DISABLED_VIOLATIONS_FOUND');
  assert.equal(report.rules[0].setting_changed_by, 'admin@example.com');
  assert.equal(check(report, 'CIS-5.2.6')[0].status, 'VIOLATION_NOT_ENFORCED');
  assert.equal(report.manifest.sha256_before, report.manifest.sha256_after);
  assert.deepEqual(report.summary.rules_disabled, ['A.8.9', 'A.8.28'], 'A.8.28 is not in the request, so it is disabled too');
});

test('rule missing from the request is treated as disabled', () => {
  const { report } = evaluate({ manifest: basePod(), rules: [] });
  assert.equal(report.rules[0].enabled, false);
  assert.equal(report.decision, 'ALLOW');
});

test('host namespaces set to true are remediated to false', () => {
  const pod = basePod();
  Object.assign(pod.spec, { hostPID: true, hostIPC: true, hostNetwork: true });
  const { report, manifest } = evaluate({ manifest: pod, rules: A89_ON });

  assert.equal(manifest.spec.hostPID, false);
  assert.equal(manifest.spec.hostIPC, false);
  assert.equal(manifest.spec.hostNetwork, false);
  for (const id of ['CIS-5.2.3', 'CIS-5.2.4', 'CIS-5.2.5']) assert.equal(check(report, id)[0].status, 'REMEDIATED');
  assert.equal(report.decision, 'ALLOW');
});

test('hostPath volume and hostPort block the deployment', () => {
  const pod = basePod();
  pod.spec.volumes.push({ name: 'host-root', hostPath: { path: '/' } });
  pod.spec.containers[0].ports.push({ containerPort: 22, hostPort: 2222 });
  const { report } = evaluate({ manifest: pod, rules: A89_ON });

  assert.equal(report.decision, 'DENY');
  assert.equal(report.compliant, false);
  assert.equal(report.rules[0].outcome, 'BLOCKED');
  assert.equal(check(report, 'CIS-5.2.12')[0].status, 'BLOCKED');
  assert.equal(check(report, 'CIS-5.2.12')[0].before, '/');
  assert.equal(check(report, 'CIS-5.2.13')[0].status, 'BLOCKED');
  assert.equal(report.summary.blocked, 2);
});

test('hostPath with the rule OFF is reported but does not block', () => {
  const pod = basePod();
  pod.spec.volumes.push({ name: 'host-root', hostPath: { path: '/' } });
  const { report } = evaluate({ manifest: pod, rules: A89_OFF });
  assert.equal(report.decision, 'ALLOW');
  assert.equal(check(report, 'CIS-5.2.12')[0].status, 'VIOLATION_NOT_ENFORCED');
});

test('privileged container cannot get allowPrivilegeEscalation=false and is blocked with a reason', () => {
  const pod = basePod();
  pod.spec.containers[0].securityContext = { privileged: true };
  const { report, manifest } = evaluate({ manifest: pod, rules: A89_ON });
  const finding = check(report, 'CIS-5.2.6')[0];
  assert.equal(finding.status, 'BLOCKED');
  assert.match(finding.reason, /A\.8\.2/);
  assert.equal(manifest.spec.containers[0].securityContext.allowPrivilegeEscalation, undefined);
});

test('init containers are checked too and existing securityContext is preserved', () => {
  const pod = basePod();
  pod.spec.initContainers = [{ name: 'init', image: 'busybox', securityContext: { runAsUser: 1000 } }];
  const { manifest, report } = evaluate({ manifest: pod, rules: A89_ON });
  assert.deepEqual(manifest.spec.initContainers[0].securityContext, { runAsUser: 1000, allowPrivilegeEscalation: false });
  assert.equal(check(report, 'CIS-5.2.6').length, 2);
});

test('works on Deployments (Pod template) and rejects non-workload kinds', () => {
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web' }, spec: { template: { spec: basePod().spec } } };
  const { manifest } = evaluate({ manifest: deployment, rules: A89_ON });
  assert.equal(manifest.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation, false);

  assert.throws(() => evaluate({ manifest: { kind: 'Service', spec: {} }, rules: A89_ON }), /Unsupported kind/);
});

test('report carries context, engine version, ruleset and unknown rule ids', () => {
  const { report } = evaluate({
    manifest: basePod(),
    rules: [...A89_ON, { id: 'A.8.99', enabled: true }],
    context: { platform: 'thesis-workstations', owner: 'dev@example.com' },
  });
  assert.equal(report.subject.context.owner, 'dev@example.com');
  assert.equal(report.subject.name, 'workstation-test-0001');
  assert.match(report.report_id, /^[0-9a-f-]{36}$/);
  assert.ok(report.engine.version);
  assert.deepEqual(report.unknown_rules, ['A.8.99']);
  assert.equal(report.ruleset[0].iso.control, 'A.8.9');
});
