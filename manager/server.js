const express = require('express');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

const auth = require('./auth');
const { runMigrations } = require('./migrate');
// Lifecycle των workstations στο k3s (χρησιμοποιεί τον Kubernetes client)
const workstations = require('./workstations');
// Client του Compliance Engine (ξεχωριστή υπηρεσία)
const compliance = require('./compliance');
// Επανεξέταση του cluster (A.8.9): πότε τρέχει το CIS scan του Compliance Engine
const clusterScans = require('./cluster-scans');

const app = express();
const PORT = process.env.PORT || 5000;
const PAGES_DIR = path.join(__dirname, 'public');
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Europe/Athens';

const { requireAuth, requireAdmin, pageAuth } = auth;
const { HttpError } = workstations;

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// Βασικά security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(auth.loadUser);

const clientIp = (req) => req.ip || '127.0.0.1';
// Αν δεν οριστεί PUBLIC_HOST, χρησιμοποιείται η διεύθυνση με την οποία άνοιξε ο χρήστης τη σελίδα
const publicHost = (req) => process.env.PUBLIC_HOST || req.hostname;
const isUuid = (value) => /^[0-9a-f-]{36}$/i.test(value);

// Κοινή καταγραφή ενεργειών που δεν αφορούν συγκεκριμένο workstation (login, διαχείριση χρηστών)
const auditEvent = (stage, rule, status, details, actorId = null) =>
  workstations.audit(null, stage, rule, status, details, actorId);

// Το reconcile καλείται από τις λίστες (polling)· περιορίζεται σε μία εκτέλεση ανά 5 δευτερόλεπτα.
let lastReconcile = 0;
let reconcileRunning = null;
function reconcileThrottled() {
  if (reconcileRunning) return reconcileRunning;
  if (Date.now() - lastReconcile < 5000) return Promise.resolve();
  reconcileRunning = workstations.reconcileWithCluster()
    .catch((err) => console.error('[WARN] Reconcile with cluster failed:', workstations.describeK8sError(err)))
    .finally(() => { lastReconcile = Date.now(); reconcileRunning = null; });
  return reconcileRunning;
}

// =====================================================================
// Public
// =====================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'UP', message: 'Manager Glue Layer is running' });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ip = clientIp(req);

  if (auth.isLoginBlocked(ip, email)) {
    await auditEvent('AUTH', 'LOGIN', 'BLOCKED', { email, ip });
    return res.status(429).json({ error: 'Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.' });
  }

  const result = await pool.query(
    'SELECT id, password_hash, is_active, must_change_password, role FROM users WHERE LOWER(email) = $1',
    [email]
  );
  const user = result.rows[0];
  // Ίδιος χρόνος απόκρισης είτε υπάρχει το email είτε όχι
  const passwordOk = await auth.verifyPassword(password, user ? user.password_hash : await auth.dummyHash());

  if (!user || !passwordOk || !user.is_active) {
    auth.recordLoginFailure(ip, email);
    await auditEvent('AUTH', 'LOGIN', 'FAILED', { email, ip, reason: user && !user.is_active ? 'inactive account' : 'invalid credentials' }, user ? user.id : null);
    return res.status(401).json({ error: 'Λάθος email ή κωδικός' });
  }

  auth.clearLoginFailures(ip, email);
  await auth.createSession(res, user.id, req);
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
  await auditEvent('AUTH', 'LOGIN', 'SUCCESS', { email, ip }, user.id);
  res.json({ success: true, role: user.role, must_change_password: user.must_change_password });
});

// =====================================================================
// Οποιοσδήποτε συνδεδεμένος χρήστης
// =====================================================================

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.user);
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await auth.destroySession(req, res);
  await auditEvent('AUTH', 'LOGOUT', 'SUCCESS', { email: req.user.email }, req.user.id);
  res.json({ success: true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');

  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await auth.verifyPassword(current, result.rows[0].password_hash))) {
    return res.status(400).json({ error: 'Ο τρέχων κωδικός δεν είναι σωστός' });
  }
  const weakness = auth.validatePasswordStrength(next);
  if (weakness) return res.status(400).json({ error: weakness });
  if (next === current) return res.status(400).json({ error: 'Ο νέος κωδικός πρέπει να είναι διαφορετικός' });

  await pool.query('UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1', [req.user.id, await auth.hashPassword(next)]);
  // Αποσύνδεση από όλες τις άλλες συσκευές, νέο session για την τρέχουσα
  await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [req.user.id]);
  await auth.createSession(res, req.user.id, req);
  await auditEvent('AUTH', 'PASSWORD-CHANGE', 'SUCCESS', { email: req.user.email }, req.user.id);
  res.json({ success: true, role: req.user.role });
});

app.get('/api/profiles', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT id, name, display_name, description FROM profiles ORDER BY id ASC');
  res.json(result.rows);
});

// Νέο αίτημα workstation (developer → αναμονή έγκρισης, admin → αυτόματη έγκριση)
app.post('/api/workstations/request', requireAuth, async (req, res) => {
  const profileId = Number.parseInt(req.body.profile_id, 10);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'Μη έγκυρο profile' });

  const ws = await workstations.createRequest({
    user: req.user,
    profileId,
    clientIp: clientIp(req),
    publicHost: publicHost(req),
  });
  res.status(201).json({ success: true, data: workstations.toApiWorkstation(ws, req.user) });
});

// Τα workstations του συνδεδεμένου χρήστη
app.get('/api/my/workstations', requireAuth, async (req, res) => {
  await reconcileThrottled();
  const rows = await workstations.listWorkstations({ userId: req.user.id });
  res.json(rows.map((w) => workstations.toApiWorkstation(w, req.user)));
});

// Compliance report (workspace-logs): το επίσημο report του Compliance Engine, με έλεγχο ακεραιότητας (SHA-256).
// Μόνο για τον admin (αποδεικτικό για τον auditor). Διαθέσιμο και μετά τον τερματισμό του workstation.
app.get('/api/workstations/:id/compliance-report', requireAdmin, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Compliance report not found' });
  const ref = await workstations.getComplianceReportRef(req.params.id, req.user);
  let data;
  try {
    data = await compliance.fetchReport(ref.report_id, ref.report_sha256.trim());
  } catch (err) {
    if (!(err instanceof compliance.ComplianceEngineError)) throw err;
    await auditEvent('COMPLIANCE', 'REPORT-DOWNLOAD', 'FAILED', { workstation_id: req.params.id, report_id: ref.report_id, error: err.message }, req.user.id);
    return res.status(502).json({ error: err.message });
  }
  await auditEvent('COMPLIANCE', 'REPORT-DOWNLOAD', 'SUCCESS', { workstation_id: req.params.id, report_id: ref.report_id }, req.user.id);
  res.setHeader('Content-Disposition', `attachment; filename="workspace-logs-${ref.pod_name}.json"`);
  res.setHeader('X-Report-SHA256', ref.report_sha256.trim());
  res.type('application/json; charset=utf-8').send(data);
});

// Τερματισμός (ή ακύρωση αιτήματος): ο κάτοχος για τα δικά του, ο admin για όλα
app.delete('/api/workstations/:id', requireAuth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Workstation not found' });
  await workstations.terminateWorkstation(req.params.id, req.user);
  res.json({ success: true });
});

// =====================================================================
// Μόνο admin
// =====================================================================

app.get('/api/workstations', requireAdmin, async (req, res) => {
  await reconcileThrottled();
  const rows = await workstations.listWorkstations();
  res.json(rows.map((w) => workstations.toApiWorkstation(w, req.user)));
});

// Notifications: αιτήματα σε αναμονή έγκρισης
app.get('/api/approvals', requireAdmin, async (req, res) => {
  const rows = await workstations.listPendingApprovals();
  res.json(rows.map((w) => workstations.toApiWorkstation(w, req.user)));
});

app.get('/api/approvals/count', requireAdmin, async (req, res) => {
  res.json({ count: await workstations.countPendingApprovals() });
});

app.post('/api/workstations/:id/approve', requireAdmin, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Workstation not found' });
  await workstations.approveRequest(req.params.id, req.user, publicHost(req));
  res.json({ success: true });
});

app.post('/api/workstations/:id/reject', requireAdmin, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Workstation not found' });
  await workstations.rejectRequest(req.params.id, req.user, req.body.note);
  res.json({ success: true });
});

// ---------- Επανεξέταση του cluster (CIS scan με kube-bench, A.8.9) ----------

// Κατ' απαίτηση (κουμπί "Έλεγχος cluster τώρα"): περιμένει το αποτέλεσμα (έως μερικά λεπτά)
app.post('/api/cluster-scans', requireAdmin, async (req, res) => {
  try {
    const result = await clusterScans.runClusterScan({ trigger: 'MANUAL', actor: req.user });
    res.json({ success: true, scan: result });
  } catch (err) {
    if (err instanceof compliance.ComplianceEngineError) return res.status(502).json({ error: err.message });
    throw err;
  }
});

app.get('/api/cluster-scans/latest', requireAdmin, async (req, res) => {
  res.json(await clusterScans.latestScan());
});

// cluster-logs: το αποτέλεσμα ενός scan, με έλεγχο ακεραιότητας (SHA-256)
app.get('/api/cluster-scans/:id/report', requireAdmin, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Cluster report not found' });
  const scan = await clusterScans.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Cluster report not found' });
  let data;
  try {
    data = await compliance.fetchClusterReport(scan.scan_id, scan.report_sha256.trim());
  } catch (err) {
    if (!(err instanceof compliance.ComplianceEngineError)) throw err;
    await auditEvent('CLUSTER', 'REPORT-DOWNLOAD', 'FAILED', { scan_id: scan.scan_id, error: err.message }, req.user.id);
    return res.status(502).json({ error: err.message });
  }
  await auditEvent('CLUSTER', 'REPORT-DOWNLOAD', 'SUCCESS', { scan_id: scan.scan_id }, req.user.id);
  const stamp = new Date(scan.created_at).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  res.setHeader('Content-Disposition', `attachment; filename="cluster-logs-${stamp}.json"`);
  res.setHeader('X-Report-SHA256', scan.report_sha256.trim());
  res.type('application/json; charset=utf-8').send(data);
});

// Πολιτικές ασφαλείας (checklist)
app.get('/api/policies', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT pr.*, p.display_name as profile_name
    FROM policy_rules pr
    JOIN profiles p ON pr.profile_id = p.id
    ORDER BY pr.id ASC
  `);
  res.json(result.rows);
});

app.post('/api/policies/toggle', requireAdmin, async (req, res) => {
  const ruleId = Number.parseInt(req.body.rule_id, 10);
  if (!Number.isInteger(ruleId) || typeof req.body.is_enabled !== 'boolean') {
    return res.status(400).json({ error: 'Μη έγκυρα δεδομένα' });
  }
  // Το ποιος και πότε άλλαξε τον κανόνα εμφανίζεται στο compliance report (π.χ. για απενεργοποιημένους κανόνες)
  await pool.query('UPDATE policy_rules SET is_enabled = $1, updated_at = NOW(), updated_by = $3 WHERE id = $2', [req.body.is_enabled, ruleId, req.user.id]);
  await auditEvent('POLICY', 'POLICY-TOGGLE', 'SUCCESS', { rule_id: ruleId, is_enabled: req.body.is_enabled }, req.user.id);
  res.json({ success: true, message: 'Policy status updated' });
});

// ---------- Διαχείριση χρηστών ----------

const USER_FIELDS = 'id, email, full_name, username, role, is_active, must_change_password, created_at, last_login_at';

app.get('/api/users', requireAdmin, async (req, res) => {
  const result = await pool.query(`SELECT ${USER_FIELDS} FROM users ORDER BY created_at ASC`);
  res.json(result.rows);
});

// Δημιουργία χρήστη με τυχαίο προσωρινό κωδικό (εμφανίζεται μία φορά στον admin)
app.post('/api/users', requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.full_name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || 'developer');

  if (!auth.EMAIL_PATTERN.test(email)) return res.status(400).json({ error: 'Μη έγκυρο email' });
  if (fullName.length < 2 || fullName.length > 150) return res.status(400).json({ error: 'Μη έγκυρο ονοματεπώνυμο' });
  if (!auth.USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Username: μόνο πεζά λατινικά, αριθμοί και παύλα (-), έως 30 χαρακτήρες' });
  }
  if (!auth.ROLES.includes(role)) return res.status(400).json({ error: 'Μη έγκυρος ρόλος' });

  const temporaryPassword = auth.generatePassword();
  try {
    const result = await pool.query(
      `INSERT INTO users (email, full_name, username, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING ${USER_FIELDS}`,
      [email, fullName, username, role, await auth.hashPassword(temporaryPassword)]
    );
    await auditEvent('USER-ADMIN', 'USER-CREATED', 'SUCCESS', { email, username, role }, req.user.id);
    res.status(201).json({ success: true, user: result.rows[0], temporary_password: temporaryPassword });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Υπάρχει ήδη χρήστης με αυτό το email ή username' });
    throw err;
  }
});

// Αλλαγή ρόλου / ενεργοποίηση-απενεργοποίηση
app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const target = (await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  const role = req.body.role !== undefined ? String(req.body.role) : target.role;
  const isActive = req.body.is_active !== undefined ? req.body.is_active === true : target.is_active;
  if (!auth.ROLES.includes(role)) return res.status(400).json({ error: 'Μη έγκυρος ρόλος' });
  if (id === req.user.id && (role !== 'admin' || !isActive)) {
    return res.status(400).json({ error: 'Δεν μπορείς να αφαιρέσεις τα δικαιώματα admin ή να απενεργοποιήσεις τον εαυτό σου' });
  }
  if (target.role === 'admin' && (role !== 'admin' || !isActive)) {
    const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active");
    if (admins.rows[0].count <= 1) return res.status(400).json({ error: 'Πρέπει να υπάρχει τουλάχιστον ένας ενεργός admin' });
  }

  await pool.query('UPDATE users SET role = $2, is_active = $3 WHERE id = $1', [id, role, isActive]);
  if (!isActive || role !== target.role) await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
  await auditEvent('USER-ADMIN', 'USER-UPDATED', 'SUCCESS', { email: target.email, role, is_active: isActive }, req.user.id);
  res.json({ success: true });
});

app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const target = (await pool.query('SELECT id, email FROM users WHERE id = $1', [id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  const temporaryPassword = auth.generatePassword();
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = TRUE WHERE id = $1', [id, await auth.hashPassword(temporaryPassword)]);
  await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
  await auditEvent('USER-ADMIN', 'PASSWORD-RESET', 'SUCCESS', { email: target.email }, req.user.id);
  res.json({ success: true, temporary_password: temporaryPassword });
});

// ---------- Audit trail ----------

app.get('/api/audit-logs', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT al.*, wr.username, wr.pod_name, a.email AS actor_email,
           cr.report_id IS NOT NULL AS has_compliance_report
    FROM audit_logs al
    LEFT JOIN workstation_requests wr ON al.workstation_id = wr.id
    LEFT JOIN users a ON a.id = al.actor_user_id
    LEFT JOIN compliance_reports cr ON cr.workstation_id = al.workstation_id
    ORDER BY al.timestamp DESC
    LIMIT 1000
  `);
  res.json(result.rows);
});

// GET /api/audit-logs/export?date=YYYY-MM-DD&format=json|csv - Ημερήσιο export (compliance evidence)
function toCsv(rows) {
  const columns = ['id', 'timestamp_utc', 'timestamp_local', 'actor_email', 'username', 'pod_name', 'stage', 'rule_evaluated', 'status', 'details'];
  const cell = (value) => {
    const text = value === null || value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

app.get('/api/audit-logs/export', requireAdmin, async (req, res) => {
  const date = String(req.query.date || '');
  const format = String(req.query.format || 'json').toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'Η ημερομηνία πρέπει να είναι της μορφής YYYY-MM-DD' });
  }
  if (!['json', 'csv'].includes(format)) {
    return res.status(400).json({ error: 'Το format πρέπει να είναι json ή csv' });
  }

  // Τα timestamps αποθηκεύονται σε UTC. Η "ημέρα" υπολογίζεται στη ζώνη ώρας REPORT_TIMEZONE.
  const result = await pool.query(`
    SELECT al.id,
           to_char(al.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp_utc,
           to_char(al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI:SS') AS timestamp_local,
           a.email AS actor_email, wr.username, wr.pod_name, al.stage, al.rule_evaluated, al.status, al.details
    FROM audit_logs al
    LEFT JOIN workstation_requests wr ON al.workstation_id = wr.id
    LEFT JOIN users a ON a.id = al.actor_user_id
    WHERE (al.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2)::date = $1::date
    ORDER BY al.timestamp ASC
  `, [date, REPORT_TIMEZONE]);

  const filename = `audit-logs-${date}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'csv') {
    res.type('text/csv; charset=utf-8').send('﻿' + toCsv(result.rows)); // BOM για σωστά ελληνικά στο Excel
  } else {
    res.json({
      report: 'Compliance audit trail',
      date,
      timezone: REPORT_TIMEZONE,
      exported_at: new Date().toISOString(),
      exported_by: req.user.email,
      count: result.rows.length,
      records: result.rows,
    });
  }
});

// =====================================================================
// Σελίδες (δεν σερβίρονται ως στατικά αρχεία, ώστε να μην παρακάμπτεται ο έλεγχος)
// =====================================================================

app.get('/login', (req, res) => {
  if (req.user && !req.user.must_change_password) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  res.sendFile(path.join(PAGES_DIR, 'login.html'));
});

app.get('/', pageAuth(), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'index.html'));
});

app.get('/admin', pageAuth('admin'), (req, res) => {
  res.sendFile(path.join(PAGES_DIR, 'admin.html'));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Κεντρικός χειρισμός σφαλμάτων (το Express 5 προωθεί εδώ και τα σφάλματα των async handlers)
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Μη έγκυρο JSON' });
  console.error('[ERROR]', req.method, req.path, err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[CRITICAL] Database migrations failed:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[SERVER] Manager API & Frontend UI running on port ${PORT}`);
    workstations.startSessionSweeper([auth.deleteExpiredSessions]);
    clusterScans.startClusterScanScheduler();
  });
}

start();
