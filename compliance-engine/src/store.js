// Αποδεικτικά του εργαλείου: ένα αρχείο JSON ανά report και ημερήσιο log αποφάσεων (JSON Lines, μόνο προσθήκες).
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./canonical');

const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createStore(dataDir) {
  const reportsDir = path.join(dataDir, 'reports');
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(reportsDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o750 });

  // Γράφει το report ατομικά (tmp + rename) και επιστρέφει το SHA-256 των bytes που αποθηκεύτηκαν.
  function saveReport(report) {
    const body = `${JSON.stringify(report, null, 2)}\n`;
    const file = path.join(reportsDir, `${report.report_id}.json`);
    fs.writeFileSync(`${file}.tmp`, body, { mode: 0o640 });
    fs.renameSync(`${file}.tmp`, file);
    const hash = sha256(body);

    const day = report.generated_at.slice(0, 10);
    const line = {
      timestamp: report.generated_at,
      report_id: report.report_id,
      report_sha256: hash,
      decision: report.decision,
      subject: { kind: report.subject.kind, name: report.subject.name, namespace: report.subject.namespace },
      context: report.subject.context,
      rules: report.rules.map((r) => ({ rule: r.rule, enabled: r.enabled, outcome: r.outcome })),
      summary: report.summary,
    };
    fs.appendFileSync(path.join(logsDir, `decisions-${day}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o640 });
    return hash;
  }

  // Επιστρέφει τα αυτούσια bytes του report (ώστε ο καλών να μπορεί να ελέγξει το SHA-256), ή null.
  function readReport(reportId) {
    if (!REPORT_ID.test(reportId)) return null;
    const file = path.join(reportsDir, `${reportId}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  // ---------- Επανεξέταση του cluster (cluster-logs) ----------
  const clusterDir = path.join(dataDir, 'cluster');
  fs.mkdirSync(clusterDir, { recursive: true, mode: 0o750 });

  // Το τελευταίο scan (για την ενότητα "Έλεγχος cluster" κάθε workspace-logs)
  let latestCluster = null;
  for (const name of fs.readdirSync(clusterDir).filter((f) => f.endsWith('.json'))) {
    const body = fs.readFileSync(path.join(clusterDir, name), 'utf8');
    try {
      const report = JSON.parse(body);
      if (!latestCluster || report.generated_at > latestCluster.report.generated_at) latestCluster = { report, sha256: sha256(body) };
    } catch (_) { /* μη έγκυρο αρχείο: αγνοείται */ }
  }

  function saveClusterReport(report) {
    const body = `${JSON.stringify(report, null, 2)}\n`;
    const file = path.join(clusterDir, `${report.scan_id}.json`);
    fs.writeFileSync(`${file}.tmp`, body, { mode: 0o640 });
    fs.renameSync(`${file}.tmp`, file);
    const hash = sha256(body);
    latestCluster = { report, sha256: hash };

    const line = {
      timestamp: report.generated_at,
      type: 'cluster-review',
      scan_id: report.scan_id,
      report_sha256: hash,
      status: report.status,
      trigger: report.trigger,
      requested_by: report.requested_by,
      summary: report.summary,
    };
    fs.appendFileSync(path.join(logsDir, `decisions-${report.generated_at.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o640 });
    return hash;
  }

  function readClusterReport(scanId) {
    if (!REPORT_ID.test(scanId)) return null;
    const file = path.join(clusterDir, `${scanId}.json`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  const latestClusterReport = () => latestCluster;

  return { saveReport, readReport, saveClusterReport, readClusterReport, latestClusterReport };
}

module.exports = { createStore };
