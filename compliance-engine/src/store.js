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

  return { saveReport, readReport };
}

module.exports = { createStore };
