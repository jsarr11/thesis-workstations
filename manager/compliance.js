// Client του Compliance Engine (ξεχωριστή υπηρεσία, βλ. compliance-engine/integration-instructions.md).
// Fail-closed: αν το εργαλείο δεν έχει ρυθμιστεί ή δεν απαντά, η κλήση αποτυγχάνει και το deploy δεν γίνεται.
require('dotenv').config({ path: __dirname + '/.env' });
const crypto = require('crypto');

const ENGINE_URL = (process.env.COMPLIANCE_ENGINE_URL || '').replace(/\/+$/, '');
const ENGINE_API_KEY = process.env.COMPLIANCE_ENGINE_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.COMPLIANCE_ENGINE_TIMEOUT_MS || '10000', 10);
// Το CIS scan του cluster (kube-bench) διαρκεί πολύ περισσότερο· την πρώτη φορά κατεβαίνει και το image.
const CLUSTER_SCAN_TIMEOUT_MS = parseInt(process.env.CLUSTER_SCAN_TIMEOUT_MS || '420000', 10);

class ComplianceEngineError extends Error {}

async function request(path, { timeoutMs = TIMEOUT_MS, ...options } = {}) {
  if (!ENGINE_URL || !ENGINE_API_KEY) {
    throw new ComplianceEngineError('Compliance Engine is not configured (COMPLIANCE_ENGINE_URL / COMPLIANCE_ENGINE_API_KEY)');
  }
  let res;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENGINE_API_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ComplianceEngineError(`Compliance Engine unavailable: ${err.cause ? err.cause.message || err.cause.code : err.message}`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ComplianceEngineError(`Compliance Engine error ${res.status}: ${body.error || res.statusText}`);
  }
  return res;
}

// { manifest, rules: [{ id, enabled, changed_by, changed_at }], context } → { report_id, report_sha256, decision, compliant, summary, rules, manifest }
async function evaluate(payload) {
  const res = await request('/evaluate', { method: 'POST', body: JSON.stringify(payload) });
  return res.json();
}

// Επιστρέφει τα bytes ενός αποθηκευμένου αρχείου αφού ελέγξει ότι ταιριάζουν με το SHA-256 που κρατά η πλατφόρμα.
async function fetchVerified(path, expectedSha256) {
  const res = await request(path);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expectedSha256) {
    throw new ComplianceEngineError(`Report integrity check failed (expected ${expectedSha256}, got ${actual})`);
  }
  return data;
}

// workspace-logs ενός workstation
const fetchReport = (reportId, expectedSha256) => fetchVerified(`/reports/${encodeURIComponent(reportId)}`, expectedSha256);

// Επανεξέταση του cluster (kube-bench + Pod Security Admission) → { scan_id, report_sha256, status, trigger, generated_at, summary, error? }
async function clusterScan({ trigger, requestedBy = null }) {
  const res = await request('/cluster/scan', {
    method: 'POST',
    body: JSON.stringify({ trigger, requested_by: requestedBy }),
    timeoutMs: CLUSTER_SCAN_TIMEOUT_MS,
  });
  return res.json();
}

// cluster-logs ενός scan
const fetchClusterReport = (scanId, expectedSha256) => fetchVerified(`/cluster/reports/${encodeURIComponent(scanId)}`, expectedSha256);

module.exports = { evaluate, fetchReport, clusterScan, fetchClusterReport, ComplianceEngineError };
