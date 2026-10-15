// Επανεξέταση του cluster (A.8.9): η πλατφόρμα αποφασίζει ΠΟΤΕ, το Compliance Engine ΚΑΝΕΙ τον έλεγχο
// (kube-bench + Pod Security Admission) και κρατά το αποδεικτικό (cluster-logs).
//   - μία φορά την ημέρα (CLUSTER_SCAN_INTERVAL_HOURS, προεπιλογή 24)
//   - σε κάθε εκκίνηση του Manager (άρα σε κάθε deploy)
//   - κατ' απαίτηση από τον admin (κουμπί στο /admin)
const pool = require('./db');
const compliance = require('./compliance');

const INTERVAL_HOURS = Number.parseFloat(process.env.CLUSTER_SCAN_INTERVAL_HOURS || '24');
const CHECK_EVERY_MS = 10 * 60 * 1000;   // κάθε 10 λεπτά ελέγχεται αν ήρθε η ώρα του επόμενου scan
// Λίγο μετά την εκκίνηση, ώστε να έχει ξεκινήσει και το Compliance Engine
const STARTUP_DELAY_MS = Number.parseInt(process.env.CLUSTER_SCAN_STARTUP_DELAY_MS || '30000', 10);

let running = null;

async function audit(stage, rule, status, details, actorId = null) {
  await pool.query(
    'INSERT INTO audit_logs (workstation_id, stage, rule_evaluated, status, details, actor_user_id) VALUES (NULL, $1, $2, $3, $4, $5)',
    [stage, rule, status, JSON.stringify(details || {}), actorId]
  );
}

// Εκτελεί ένα scan. Αν τρέχει ήδη κάποιο, επιστρέφει αυτό (δεν ξεκινούν δύο ταυτόχρονα).
function runClusterScan({ trigger, actor = null }) {
  if (running) return running;
  running = (async () => {
    console.log(`[LOG] Cluster review (CIS scan) started — trigger ${trigger}${actor ? ` by ${actor.email}` : ''}`);
    try {
      const result = await compliance.clusterScan({ trigger, requestedBy: actor ? actor.email : null });
      await pool.query(
        `INSERT INTO cluster_scans (scan_id, report_sha256, status, trigger, requested_by, summary)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [result.scan_id, result.report_sha256, result.status, result.trigger, actor ? actor.id : null, JSON.stringify(result.summary)]
      );
      await audit('CLUSTER', 'CIS-SCAN', result.status, {
        scan_id: result.scan_id,
        trigger: result.trigger,
        summary: result.summary,
        ...(result.error ? { error: result.error } : {}),
      }, actor ? actor.id : null);
      const s = result.summary;
      console.log(`[LOG] Cluster review ${result.status}: ${s.pass} PASS · ${s.fail} FAIL · ${s.warn} WARN · PSA ${s.psa_compliant ? 'OK' : 'NOT OK'}`);
      return result;
    } catch (err) {
      await audit('CLUSTER', 'CIS-SCAN', 'FAILED', { trigger, error: err.message }, actor ? actor.id : null).catch(() => {});
      console.error(`[ERROR] Cluster review failed: ${err.message}`);
      throw err;
    }
  })().finally(() => { running = null; });
  return running;
}

async function latestScan() {
  const res = await pool.query(
    `SELECT cs.*, u.email AS requested_by_email
       FROM cluster_scans cs LEFT JOIN users u ON u.id = cs.requested_by
      ORDER BY cs.created_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

async function getScan(scanId) {
  const res = await pool.query('SELECT * FROM cluster_scans WHERE scan_id = $1', [scanId]);
  return res.rows[0] || null;
}

async function scanIfDue() {
  const res = await pool.query(
    'SELECT MAX(created_at) < NOW() - make_interval(secs => $1) OR MAX(created_at) IS NULL AS due FROM cluster_scans',
    [Math.round(INTERVAL_HOURS * 3600)]
  );
  if (res.rows[0].due) await runClusterScan({ trigger: 'SCHEDULED' });
}

function startClusterScanScheduler() {
  if (!Number.isFinite(INTERVAL_HOURS) || INTERVAL_HOURS <= 0) {
    console.log('[CLUSTER] Automatic cluster review disabled (CLUSTER_SCAN_INTERVAL_HOURS)');
    return;
  }
  setTimeout(() => runClusterScan({ trigger: 'STARTUP' }).catch(() => {}), STARTUP_DELAY_MS);
  setInterval(() => scanIfDue().catch((err) => console.error('[WARN] Cluster review check failed:', err.message)), CHECK_EVERY_MS);
  console.log(`[CLUSTER] Cluster review (kube-bench) at startup and every ${INTERVAL_HOURS}h`);
}

module.exports = { runClusterScan, latestScan, getScan, startClusterScanScheduler };
