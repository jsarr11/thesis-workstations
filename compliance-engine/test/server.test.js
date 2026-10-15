const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createServer } = require('../src/server');

const API_KEY = 'test-key-0123456789abcdef0123456789abcdef';
const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'workstation-test-0002' },
  spec: { containers: [{ name: 'workspace', image: 'workstation-profile:developer' }] },
};

let server;
let baseUrl;
let dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-engine-test-'));
  server = createServer({ host: '127.0.0.1', port: 0, apiKey: API_KEY, dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = (urlPath, { key = API_KEY, ...options } = {}) => fetch(`${baseUrl}${urlPath}`, {
  ...options,
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
});

test('health is public, everything else requires the API key', async () => {
  assert.equal((await call('/health', { key: null })).status, 200);
  assert.equal((await call('/rules', { key: null })).status, 401);
  assert.equal((await call('/rules', { key: 'wrong-key' })).status, 401);
  const rules = await (await call('/rules')).json();
  assert.equal(rules.rules[0].id, 'A.8.9');
});

test('evaluate returns the remediated manifest and stores a verifiable report and decision log', async () => {
  const res = await call('/evaluate', {
    method: 'POST',
    body: JSON.stringify({ manifest: pod, rules: [{ id: 'A.8.9', enabled: true }], context: { owner: 'dev@example.com' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, 'ALLOW');
  assert.equal(body.manifest.spec.containers[0].securityContext.allowPrivilegeEscalation, false);

  const reportRes = await call(`/reports/${body.report_id}`);
  assert.equal(reportRes.status, 200);
  const bytes = Buffer.from(await reportRes.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), body.report_sha256, 'stored report matches its hash');
  const report = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.subject.context.owner, 'dev@example.com');

  const logs = fs.readdirSync(path.join(dataDir, 'logs'));
  assert.equal(logs.length, 1);
  const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'logs', logs[0]), 'utf8').trim().split('\n').pop());
  assert.equal(line.report_id, body.report_id);
  assert.equal(line.report_sha256, body.report_sha256);
});

test('evaluate reports rules that the engine does not know', async () => {
  const res = await call('/evaluate', {
    method: 'POST',
    body: JSON.stringify({ manifest: pod, rules: [{ id: 'A.8.9', enabled: true }, { id: 'A.8.99', enabled: true }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.unknown_rules, ['A.8.99']);
  assert.equal(body.decision, 'ALLOW');
});

test('invalid input is rejected with a clear status', async () => {
  assert.equal((await call('/evaluate', { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await call('/evaluate', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await call('/evaluate', { method: 'POST', body: JSON.stringify({ manifest: { kind: 'Service' } }) })).status, 422);
  assert.equal((await call('/reports/../../etc/passwd')).status, 404);
  assert.equal((await call(`/reports/${crypto.randomUUID()}`)).status, 404);
});
