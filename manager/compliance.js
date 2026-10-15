// Client του Compliance Engine (ξεχωριστή υπηρεσία, βλ. compliance-engine/integration-instructions.md).
// Fail-closed: αν το εργαλείο δεν έχει ρυθμιστεί ή δεν απαντά, η κλήση αποτυγχάνει και το deploy δεν γίνεται.
require('dotenv').config({ path: __dirname + '/.env' });
const crypto = require('crypto');

const ENGINE_URL = (process.env.COMPLIANCE_ENGINE_URL || '').replace(/\/+$/, '');
const ENGINE_API_KEY = process.env.COMPLIANCE_ENGINE_API_KEY || '';
const TIMEOUT_MS = parseInt(process.env.COMPLIANCE_ENGINE_TIMEOUT_MS || '10000', 10);

class ComplianceEngineError extends Error {}

async function request(path, options = {}) {
  if (!ENGINE_URL || !ENGINE_API_KEY) {
    throw new ComplianceEngineError('Compliance Engine is not configured (COMPLIANCE_ENGINE_URL / COMPLIANCE_ENGINE_API_KEY)');
  }
  let res;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ENGINE_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

// Επιστρέφει τα bytes του report αφού ελέγξει ότι ταιριάζουν με το SHA-256 που κρατά η πλατφόρμα.
async function fetchReport(reportId, expectedSha256) {
  const res = await request(`/reports/${encodeURIComponent(reportId)}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expectedSha256) {
    throw new ComplianceEngineError(`Report integrity check failed (expected ${expectedSha256}, got ${actual})`);
  }
  return data;
}

module.exports = { evaluate, fetchReport, ComplianceEngineError };
