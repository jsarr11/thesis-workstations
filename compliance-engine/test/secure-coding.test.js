const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../src/engine');

// Ίδιο σχήμα με το baseline manifest της πλατφόρμας των workstations (χωρίς securityContext)
const basePod = () => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'workstation-test-0001', labels: { app: 'workstation-test-0001' } },
  spec: {
    containers: [{ name: 'workspace', image: 'workstation-profile:developer', ports: [{ containerPort: 3000 }] }],
    volumes: [{ name: 'workstation-token', secret: { secretName: 'workstation-test-0001-token' } }],
  },
});
const A828_ON = [{ id: 'A.8.28', enabled: true }];
const A828_OFF = [{ id: 'A.8.28', enabled: false, changed_by: 'admin@example.com', changed_at: '2026-10-15T10:00:00Z' }];
const BOTH_ON = [{ id: 'A.8.9', enabled: true }, ...A828_ON];
const rule = (report) => report.rules.find((r) => r.rule === 'A.8.28');
const check = (report, id) => rule(report).checks.filter((c) => c.check === id);

test('baseline Pod: A.8.28 ON sets runAsNonRoot=true on the Pod and allows deploy', () => {
  const input = basePod();
  const { report, manifest } = evaluate({ manifest: input, rules: A828_ON });

  assert.equal(report.decision, 'ALLOW');
  assert.equal(rule(report).outcome, 'REMEDIATED');
  assert.deepEqual(manifest.spec.securityContext, { runAsNonRoot: true });
  assert.equal(manifest.spec.securityContext.runAsUser, undefined, 'the engine never chooses a UID');
  assert.equal(check(report, 'CIS-5.2.7a')[0].status, 'REMEDIATED');
  assert.equal(check(report, 'CIS-5.2.7a')[0].before, null);
  assert.equal(check(report, 'CIS-5.2.7a')[0].after, true);
  assert.equal(check(report, 'CIS-5.2.7b')[0].status, 'PASS');
  assert.equal(input.spec.securityContext, undefined, 'input manifest is not mutated');
});

test('baseline Pod: A.8.28 OFF leaves manifest unchanged and records the violation as not enforced', () => {
  const input = basePod();
  const { report, manifest } = evaluate({ manifest: input, rules: A828_OFF });

  assert.equal(report.decision, 'ALLOW');
  assert.equal(manifest.spec.securityContext, undefined);
  assert.equal(rule(report).enabled, false);
  assert.equal(rule(report).outcome, 'DISABLED_VIOLATIONS_FOUND');
  assert.equal(rule(report).setting_changed_by, 'admin@example.com');
  assert.equal(check(report, 'CIS-5.2.7a')[0].status, 'VIOLATION_NOT_ENFORCED');
});

test('both rules ON on the baseline Pod: two remediations, deploy allowed', () => {
  const { report, manifest } = evaluate({ manifest: basePod(), rules: BOTH_ON });

  assert.equal(report.decision, 'ALLOW');
  assert.deepEqual(report.summary.rules_enabled, ['A.8.9', 'A.8.28']);
  assert.equal(report.summary.remediated, 2);
  assert.equal(manifest.spec.securityContext.runAsNonRoot, true);
  assert.equal(manifest.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
});

test('existing Pod securityContext is preserved and runAsNonRoot=true passes', () => {
  const pod = basePod();
  pod.spec.securityContext = { runAsUser: 1000, fsGroup: 1000 };
  const { manifest } = evaluate({ manifest: pod, rules: A828_ON });
  assert.deepEqual(manifest.spec.securityContext, { runAsUser: 1000, fsGroup: 1000, runAsNonRoot: true });

  const ok = basePod();
  ok.spec.securityContext = { runAsNonRoot: true };
  const { report } = evaluate({ manifest: ok, rules: A828_ON });
  assert.equal(rule(report).outcome, 'COMPLIANT');
});

test('runAsNonRoot=true on every container (also init) counts as compliant without a Pod setting', () => {
  const pod = basePod();
  pod.spec.initContainers = [{ name: 'init', image: 'busybox', securityContext: { runAsNonRoot: true } }];
  pod.spec.containers[0].securityContext = { runAsNonRoot: true };
  const { report, manifest } = evaluate({ manifest: pod, rules: A828_ON });
  assert.equal(check(report, 'CIS-5.2.7a')[0].status, 'PASS');
  assert.equal(manifest.spec.securityContext, undefined);

  delete pod.spec.initContainers[0].securityContext;
  const second = evaluate({ manifest: pod, rules: A828_ON });
  assert.equal(check(second.report, 'CIS-5.2.7a')[0].status, 'REMEDIATED', 'one container without it is enough');
});

test('runAsUser 0 on the Pod or on a container blocks the deployment', () => {
  const pod = basePod();
  pod.spec.securityContext = { runAsUser: 0 };
  pod.spec.initContainers = [{ name: 'init', image: 'busybox', securityContext: { runAsUser: 0 } }];
  const { report } = evaluate({ manifest: pod, rules: A828_ON });

  assert.equal(report.decision, 'DENY');
  assert.equal(rule(report).outcome, 'BLOCKED');
  const blocked = check(report, 'CIS-5.2.7b');
  assert.equal(blocked.length, 2);
  assert.deepEqual(blocked.map((c) => c.target), ['spec.securityContext.runAsUser', 'spec.initContainers[0].securityContext.runAsUser']);
  assert.ok(blocked.every((c) => c.status === 'BLOCKED' && c.before === 0 && c.reason));
});

test('runAsNonRoot=false is never overwritten: on the Pod (5.2.7a) and on a container (5.2.7b) it blocks', () => {
  const pod = basePod();
  pod.spec.securityContext = { runAsNonRoot: false };
  const first = evaluate({ manifest: pod, rules: A828_ON });
  assert.equal(check(first.report, 'CIS-5.2.7a')[0].status, 'BLOCKED');
  assert.match(check(first.report, 'CIS-5.2.7a')[0].reason, /explicitly set to false/);
  assert.equal(first.manifest.spec.securityContext.runAsNonRoot, false);

  const pod2 = basePod();
  pod2.spec.containers[0].securityContext = { runAsNonRoot: false };
  const second = evaluate({ manifest: pod2, rules: A828_ON });
  assert.equal(second.report.decision, 'DENY');
  assert.equal(check(second.report, 'CIS-5.2.7b')[0].target, 'spec.containers[0].securityContext.runAsNonRoot');
  assert.equal(check(second.report, 'CIS-5.2.7b')[0].container, 'workspace');
});

test('explicit root with the rule OFF is reported but does not block', () => {
  const pod = basePod();
  pod.spec.containers[0].securityContext = { runAsUser: 0 };
  const { report } = evaluate({ manifest: pod, rules: A828_OFF });
  assert.equal(report.decision, 'ALLOW');
  assert.equal(check(report, 'CIS-5.2.7b')[0].status, 'VIOLATION_NOT_ENFORCED');
});

test('works on Deployments (Pod template)', () => {
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web' }, spec: { template: { spec: basePod().spec } } };
  const { manifest } = evaluate({ manifest: deployment, rules: A828_ON });
  assert.equal(manifest.spec.template.spec.securityContext.runAsNonRoot, true);
});

test('ruleset lists A.8.28 with its two checks', () => {
  const { report } = evaluate({ manifest: basePod(), rules: A828_ON });
  const described = report.ruleset.find((r) => r.id === 'A.8.28');
  assert.equal(described.iso.control, 'A.8.28');
  assert.deepEqual(described.checks.map((c) => [c.id, c.remediation]), [['CIS-5.2.7a', 'auto'], ['CIS-5.2.7b', 'block']]);
  assert.equal(report.engine.ruleset_version, '0.2.0');
});
