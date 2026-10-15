// Workstation lifecycle: αίτημα → έγκριση/απόρριψη → deploy στο k3s → Ready → λήξη/τερματισμός,
// με συγχρονισμό βάσης–cluster και καταγραφή κάθε βήματος στο audit trail.
const crypto = require('crypto');
const pool = require('./db');
const { k8sCoreApi, k8sNamespace } = require('./k8s');
const compliance = require('./compliance');

const READY_TIMEOUT_MS = parseInt(process.env.POD_READY_TIMEOUT_MS || '120000', 10);
const POLL_INTERVAL_MS = 2000;
const ACTIVE_STATUSES = ['PENDING', 'DEPLOYING', 'RUNNING'];          // υπάρχουν (ή θα υπάρξουν) αντικείμενα στο k3s
const OPEN_STATUSES = ['WAITING_APPROVAL', ...ACTIVE_STATUSES];       // μετράνε στο όριο ανά χρήστη
const TERMINAL_STATUSES = ['TERMINATED', 'FAILED', 'EXPIRED', 'REJECTED'];
const MAX_OPEN_PER_USER = parseInt(process.env.MAX_OPEN_WORKSTATIONS_PER_USER || '2', 10);

// Μέγιστη διάρκεια συνεδρίας (session) ενός workstation — προεπιλογή 10 ώρες, μετρά από την έγκριση.
const SESSION_TTL_HOURS = Number.parseFloat(process.env.SESSION_TTL_HOURS || '10');
const SESSION_TTL_SECONDS = Math.round(SESSION_TTL_HOURS * 3600);
// Δίχτυ ασφαλείας στο Kubernetes: το kubelet τερματίζει το Pod λίγο μετά τη λήξη, ακόμα κι αν ο Manager δεν τρέχει.
const POD_DEADLINE_GRACE_SECONDS = 300;
const SESSION_SWEEP_INTERVAL_MS = 60000;

if (!Number.isFinite(SESSION_TTL_SECONDS) || SESSION_TTL_SECONDS <= 0) {
  console.error('[CRITICAL] SESSION_TTL_HOURS must be a positive number.');
  process.exit(1);
}

// Το connection token του VS Code προσαρτάται στο Pod ως αρχείο από Kubernetes Secret.
const TOKEN_MOUNT_DIR = '/var/run/workstation';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isNotFound(err) {
  return err && err.code === 404;
}

function describeK8sError(err) {
  if (err && err.body) {
    try {
      const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
      return body.message || JSON.stringify(body);
    } catch (_) {
      return String(err.body);
    }
  }
  return err ? err.message : 'Unknown error';
}

const secretNameFor = (podName) => `${podName}-token`;

// Το path του VS Code μέσα στο workstation (π.χ. /workstation-maria-0042)
const basePathFor = (podName) => `/${podName}`;

function buildManifests(podName, imageTag) {
  const labels = { app: podName, 'managed-by': 'thesis-manager' };

  // Baseline ("γυμνό") manifest — χωρίς hardening. Το διορθώνει το Compliance Engine (Stage 2) πριν από το deploy.
  const podManifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: podName, labels },
    spec: {
      activeDeadlineSeconds: SESSION_TTL_SECONDS + POD_DEADLINE_GRACE_SECONDS,
      containers: [{
        name: 'workspace',
        image: imageTag,
        imagePullPolicy: 'Never', // Τα images γίνονται import απευθείας στο containerd του k3s
        // Το upstream image ξεκινά με --without-connection-token· το αντικαθιστούμε ώστε να απαιτείται token.
        // --server-base-path: κάθε workstation σε δικό του path, ώστε το cookie του token (χωρίς Path) να δένεται
        // σε αυτό και να μη συγκρούεται με άλλα workstations στην ίδια IP (διαφορετικά NodePorts, ίδια cookies).
        command: ['/bin/sh', '-c'],
        args: [`exec "\${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server" --host 0.0.0.0 --port 3000 --connection-token-file ${TOKEN_MOUNT_DIR}/token --server-base-path ${basePathFor(podName)}`],
        ports: [{ containerPort: 3000 }],
        volumeMounts: [{ name: 'workstation-token', mountPath: TOKEN_MOUNT_DIR, readOnly: true }],
      }],
      volumes: [{ name: 'workstation-token', secret: { secretName: secretNameFor(podName), defaultMode: 0o444 } }],
    },
  };

  const serviceManifest = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: `${podName}-svc`, labels },
    spec: {
      type: 'NodePort',
      selector: { app: podName },
      ports: [{ port: 3000, targetPort: 3000 }],
    },
  };

  return { podManifest, serviceManifest };
}

function buildSecretManifest(podName, token) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretNameFor(podName), labels: { app: podName, 'managed-by': 'thesis-manager' } },
    type: 'Opaque',
    stringData: { token },
  };
}

// Επιστρέφει λόγο αποτυχίας αν το container έχει κολλήσει σε μη ανακάμψιμη κατάσταση.
function getFatalWaitingReason(pod) {
  const fatal = ['ErrImageNeverPull', 'ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CrashLoopBackOff', 'CreateContainerConfigError'];
  const statuses = (pod.status && pod.status.containerStatuses) || [];
  for (const cs of statuses) {
    const waiting = cs.state && cs.state.waiting;
    if (waiting && fatal.includes(waiting.reason)) {
      return `${waiting.reason}: ${waiting.message || ''}`.trim();
    }
  }
  if (pod.status && pod.status.phase === 'Failed') {
    return `Pod phase Failed${pod.status.reason ? ` (${pod.status.reason})` : ''}`;
  }
  return null;
}

function isPodReady(pod) {
  const conditions = (pod.status && pod.status.conditions) || [];
  return conditions.some((c) => c.type === 'Ready' && c.status === 'True');
}

async function waitForPodReady(podName) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pod = await k8sCoreApi.readNamespacedPod({ name: podName, namespace: k8sNamespace });
    const fatalReason = getFatalWaitingReason(pod);
    if (fatalReason) throw new Error(fatalReason);
    if (isPodReady(pod)) return pod;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Pod did not become Ready within ${READY_TIMEOUT_MS / 1000}s`);
}

async function deleteK8sResources(podName) {
  const deletions = [
    k8sCoreApi.deleteNamespacedPod({ name: podName, namespace: k8sNamespace }),
    k8sCoreApi.deleteNamespacedService({ name: `${podName}-svc`, namespace: k8sNamespace }),
    k8sCoreApi.deleteNamespacedSecret({ name: secretNameFor(podName), namespace: k8sNamespace }),
  ];
  const results = await Promise.allSettled(deletions);
  for (const r of results) {
    if (r.status === 'rejected' && !isNotFound(r.reason)) throw r.reason;
  }
}

async function audit(workstationId, stage, rule, status, details, actorUserId = null) {
  await pool.query(
    `INSERT INTO audit_logs (workstation_id, stage, rule_evaluated, status, details, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workstationId, stage, rule, status, JSON.stringify(details || {}), actorUserId]
  );
}

async function setStatus(workstationId, status, extra = {}) {
  await pool.query(
    `UPDATE workstation_requests
        SET status = $2,
            pod_ip = COALESCE($3, pod_ip),
            access_url = COALESCE($4, access_url),
            terminated_at = CASE WHEN $5 THEN NOW() ELSE terminated_at END
      WHERE id = $1`,
    // Το $5 είναι ξεχωριστή boolean παράμετρος: αν ξαναχρησιμοποιούσαμε το $2, η PostgreSQL
    // θα συμπέραινε διαφορετικό τύπο (VARCHAR vs TEXT) και θα απέρριπτε το query.
    [workstationId, status, extra.pod_ip || null, extra.access_url || null, TERMINAL_STATUSES.includes(status)]
  );
}

// Workstation με στοιχεία κατόχου/προφίλ και ώρα λήξης (από την έγκριση + SESSION_TTL).
const WORKSTATION_SELECT = `
  SELECT wr.*, p.display_name AS profile_name,
         u.email AS owner_email, u.full_name AS owner_name,
         r.email AS reviewer_email,
         (wr.started_at + make_interval(secs => $1)) AT TIME ZONE current_setting('TimeZone') AS expires_at,
         cr.report_id IS NOT NULL AS has_compliance_report, cr.decision AS compliance_decision
    FROM workstation_requests wr
    JOIN profiles p ON p.id = wr.profile_id
    LEFT JOIN users u ON u.id = wr.user_id
    LEFT JOIN users r ON r.id = wr.reviewed_by
    LEFT JOIN compliance_reports cr ON cr.workstation_id = wr.id`;

async function getWorkstation(workstationId) {
  const result = await pool.query(`${WORKSTATION_SELECT} WHERE wr.id = $2`, [SESSION_TTL_SECONDS, workstationId]);
  return result.rows[0] || null;
}

async function listWorkstations({ userId = null } = {}) {
  const result = userId
    ? await pool.query(`${WORKSTATION_SELECT} WHERE wr.user_id = $2 ORDER BY wr.created_at DESC`, [SESSION_TTL_SECONDS, userId])
    : await pool.query(`${WORKSTATION_SELECT} ORDER BY wr.created_at DESC`, [SESSION_TTL_SECONDS]);
  return result.rows;
}

async function listPendingApprovals() {
  const result = await pool.query(
    `${WORKSTATION_SELECT} WHERE wr.status = 'WAITING_APPROVAL' ORDER BY wr.created_at ASC`,
    [SESSION_TTL_SECONDS]
  );
  return result.rows;
}

async function countPendingApprovals() {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM workstation_requests WHERE status = 'WAITING_APPROVAL'");
  return result.rows[0].count;
}

// Το token δεν επιστρέφεται ποτέ ως πεδίο· μόνο ο κάτοχος και ο admin παίρνουν το έτοιμο link.
function toApiWorkstation(row, viewer) {
  const { access_token: token, ...ws } = row;
  const canOpen = viewer && (viewer.role === 'admin' || viewer.id === row.user_id);
  ws.access_link = canOpen && row.status === 'RUNNING' && row.access_url
    ? (token ? `${row.access_url}&tkn=${encodeURIComponent(token)}` : row.access_url)
    : null;
  delete ws.access_url;
  return ws;
}

// ---------- Αίτημα / έγκριση / απόρριψη ----------

async function createRequest({ user, profileId, clientIp, publicHost }) {
  const profileRes = await pool.query('SELECT id, image_tag FROM profiles WHERE id = $1', [profileId]);
  if (profileRes.rows.length === 0) throw new HttpError(400, 'Profile not found');

  if (user.role !== 'admin') {
    const open = await pool.query(
      'SELECT COUNT(*)::int AS count FROM workstation_requests WHERE user_id = $1 AND status = ANY($2)',
      [user.id, OPEN_STATUSES]
    );
    if (open.rows[0].count >= MAX_OPEN_PER_USER) {
      throw new HttpError(409, `Έχεις ήδη ${open.rows[0].count} ενεργά ή εκκρεμή αιτήματα (όριο: ${MAX_OPEN_PER_USER}). Τερμάτισε κάποιο πρώτα.`);
    }
  }

  const podName = `workstation-${user.username}-${crypto.randomInt(10000).toString().padStart(4, '0')}`;
  const inserted = await pool.query(
    `INSERT INTO workstation_requests (username, client_ip, profile_id, status, pod_name, user_id)
     VALUES ($1, $2, $3, 'WAITING_APPROVAL', $4, $5) RETURNING id`,
    [user.username, clientIp, profileId, podName, user.id]
  );
  const workstationId = inserted.rows[0].id;
  await audit(workstationId, 'REQUEST', 'WORKSTATION-REQUEST', 'SUBMITTED', { profileId, clientIp, pod: podName }, user.id);
  console.log(`[LOG] Request ${podName} submitted by ${user.email} — waiting for approval`);

  // Τα αιτήματα του admin εγκρίνονται αυτόματα (και καταγράφεται ως AUTO-APPROVED).
  if (user.role === 'admin') {
    await approveRequest(workstationId, user, publicHost, { auto: true });
  }
  return getWorkstation(workstationId);
}

async function approveRequest(workstationId, reviewer, publicHost, { auto = false } = {}) {
  // Ατομική μετάβαση: μόνο ένα Accept μπορεί να πετύχει για το ίδιο αίτημα.
  const updated = await pool.query(
    `UPDATE workstation_requests
        SET status = 'PENDING', reviewed_by = $2, reviewed_at = NOW(), started_at = NOW()
      WHERE id = $1 AND status = 'WAITING_APPROVAL'
      RETURNING id, pod_name`,
    [workstationId, reviewer.id]
  );
  if (updated.rows.length === 0) throw new HttpError(409, 'Το αίτημα δεν περιμένει πλέον έγκριση');

  await audit(workstationId, 'APPROVAL', 'ADMIN-REVIEW', auto ? 'AUTO-APPROVED' : 'APPROVED', {
    reviewer: reviewer.email,
    pod: updated.rows[0].pod_name,
  }, reviewer.id);
  console.log(`[LOG] Request ${updated.rows[0].pod_name} ${auto ? 'auto-approved' : 'approved'} by ${reviewer.email}`);

  // Το deploy τρέχει στο παρασκήνιο· το UI ενημερώνεται με polling.
  deployWorkstation(workstationId, publicHost).catch((err) => console.error('[ERROR] Background deploy:', err.message));
}

async function rejectRequest(workstationId, reviewer, note) {
  const reason = String(note || '').trim().slice(0, 500) || null;
  const updated = await pool.query(
    `UPDATE workstation_requests
        SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(), review_note = $3, terminated_at = NOW()
      WHERE id = $1 AND status = 'WAITING_APPROVAL'
      RETURNING id, pod_name`,
    [workstationId, reviewer.id, reason]
  );
  if (updated.rows.length === 0) throw new HttpError(409, 'Το αίτημα δεν περιμένει πλέον έγκριση');

  await audit(workstationId, 'APPROVAL', 'ADMIN-REVIEW', 'REJECTED', { reviewer: reviewer.email, reason }, reviewer.id);
  console.log(`[LOG] Request ${updated.rows[0].pod_name} rejected by ${reviewer.email}`);
}

// ---------- Compliance Engine (Stage 2) ----------
// Στέλνει το manifest και τους κανόνες του profile (ON/OFF από το Policy Checklist) στο Compliance Engine.
// Το report το κρατά το εργαλείο· η πλατφόρμα αποθηκεύει μόνο το ID και το SHA-256 του.
const isoDate = (d) => (d ? new Date(d).toISOString() : null);

async function evaluateCompliance(ws, podManifest) {
  const rules = await pool.query(
    `SELECT pr.rule_key, pr.is_enabled, pr.updated_at, u.email AS updated_by_email
       FROM policy_rules pr LEFT JOIN users u ON u.id = pr.updated_by
      WHERE pr.profile_id = $1 ORDER BY pr.id`,
    [ws.profile_id]
  );

  const result = await compliance.evaluate({
    manifest: podManifest,
    rules: rules.rows.map((r) => ({
      id: r.rule_key,
      enabled: r.is_enabled === true,
      changed_by: r.updated_by_email || null,
      changed_at: isoDate(r.updated_at),
    })),
    context: {
      platform: 'thesis-workstations',
      workstation_id: ws.id,
      pod_name: ws.pod_name,
      namespace: k8sNamespace,
      profile: ws.profile_name,
      image: ws.image_tag,
      owner: ws.owner_email,
      requested_at: isoDate(ws.created_at),
      approved_by: ws.reviewer_email,
      approved_at: isoDate(ws.reviewed_at),
    },
  });

  await pool.query(
    `INSERT INTO compliance_reports (workstation_id, report_id, report_sha256, decision, summary)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workstation_id) DO UPDATE
       SET report_id = EXCLUDED.report_id, report_sha256 = EXCLUDED.report_sha256,
           decision = EXCLUDED.decision, summary = EXCLUDED.summary, created_at = NOW()`,
    [ws.id, result.report_id, result.report_sha256, result.decision, JSON.stringify(result.summary)]
  );
  for (const r of result.rules) {
    await audit(ws.id, 'COMPLIANCE', r.rule, r.outcome, { enabled: r.enabled, report_id: result.report_id });
    console.log(`[LOG]   ${r.rule}: ${r.enabled ? 'ON' : 'OFF'} → ${r.outcome}`);
  }
  return result;
}

// ---------- Deploy (μετά την έγκριση) ----------
// Τα Steps 1 και 3 θα γίνουν πραγματικοί έλεγχοι σε επόμενους κανόνες του Compliance Engine.
async function deployWorkstation(workstationId, publicHost) {
  const res = await pool.query(
    `SELECT wr.id, wr.pod_name, wr.profile_id, wr.created_at, wr.reviewed_at,
            p.image_tag, p.name AS profile_name, u.email AS owner_email, r.email AS reviewer_email
       FROM workstation_requests wr
       JOIN profiles p ON p.id = wr.profile_id
       LEFT JOIN users u ON u.id = wr.user_id
       LEFT JOIN users r ON r.id = wr.reviewed_by
      WHERE wr.id = $1 AND wr.status = 'PENDING'`,
    [workstationId]
  );
  if (res.rows.length === 0) return;
  const ws = res.rows[0];
  const { pod_name: podName, image_tag: imageTag } = ws;
  let k8sObjectsCreated = false;

  try {
    console.log(`[LOG] Step 1: Image Validation (${imageTag}) — not implemented yet`);

    console.log('[LOG] Step 2: Manifest Generation (baseline + connection token) → Compliance Engine');
    const token = crypto.randomBytes(24).toString('base64url');
    const baseline = buildManifests(podName, imageTag);
    const evaluation = await evaluateCompliance(ws, baseline.podManifest);
    if (!evaluation.compliant) {
      // Παράβαση που δεν διορθώνεται αυτόματα: δεν δημιουργείται τίποτα στο k3s.
      await setStatus(workstationId, 'FAILED');
      await audit(workstationId, 'COMPLIANCE', 'COMPLIANCE-GATE', 'DENIED', {
        report_id: evaluation.report_id,
        summary: evaluation.summary,
      });
      console.log(`[LOG] Workstation ${podName} denied by the Compliance Engine (report ${evaluation.report_id})`);
      return;
    }
    const podManifest = evaluation.manifest;
    const { serviceManifest } = baseline;
    console.log(`[LOG] Step 2: ${evaluation.decision} — remediated ${evaluation.summary.remediated} check(s), report ${evaluation.report_id}`);

    console.log('[LOG] Step 3: Admission Gate — not implemented yet');

    console.log(`[LOG] Step 4: Deploy Secret, Pod & Service ${podName} -> namespace ${k8sNamespace}`);
    await setStatus(workstationId, 'DEPLOYING');
    await pool.query('UPDATE workstation_requests SET access_token = $2 WHERE id = $1', [workstationId, token]);
    k8sObjectsCreated = true;
    await k8sCoreApi.createNamespacedSecret({ namespace: k8sNamespace, body: buildSecretManifest(podName, token) });
    await k8sCoreApi.createNamespacedPod({ namespace: k8sNamespace, body: podManifest });
    const svc = await k8sCoreApi.createNamespacedService({ namespace: k8sNamespace, body: serviceManifest });
    const nodePort = svc.spec.ports[0].nodePort;

    console.log(`[LOG] Step 5: Waiting for Pod readiness (timeout ${READY_TIMEOUT_MS / 1000}s)`);
    const pod = await waitForPodReady(podName);

    const access_url = `http://${publicHost}:${nodePort}${basePathFor(podName)}/?folder=/home/workspace`;
    await setStatus(workstationId, 'RUNNING', { pod_ip: pod.status.podIP, access_url });
    await audit(workstationId, 'PROVISIONING', 'DEPLOY', 'SUCCESS', {
      message: 'Workstation deployed to k3s with the manifest returned by the Compliance Engine (connection token required)',
      compliance_report_id: evaluation.report_id,
      image: imageTag,
      nodePort,
      podIP: pod.status.podIP,
      sessionTtlHours: SESSION_TTL_HOURS,
    });
    console.log(`[LOG] Workstation ${podName} is Ready on port ${nodePort} (session: ${SESSION_TTL_HOURS}h)`);
  } catch (err) {
    const reason = describeK8sError(err);
    console.error(`[ERROR] Provisioning ${podName} failed: ${reason}`);
    if (k8sObjectsCreated) {
      await deleteK8sResources(podName).catch((e) => console.error('[ERROR] Cleanup failed:', describeK8sError(e)));
    }
    await setStatus(workstationId, 'FAILED');
    if (err instanceof compliance.ComplianceEngineError) {
      // Fail-closed: χωρίς έλεγχο συμμόρφωσης δεν γίνεται deploy
      await audit(workstationId, 'COMPLIANCE', 'COMPLIANCE-ENGINE', 'FAILED', { error: reason });
    } else {
      await audit(workstationId, 'PROVISIONING', 'DEPLOY', 'FAILED', { error: reason });
    }
  }
}

// Παραπομπή στο compliance report ενός workstation (μόνο για τον κάτοχο και τον admin).
async function getComplianceReportRef(workstationId, viewer) {
  const res = await pool.query(
    `SELECT cr.report_id, cr.report_sha256, wr.pod_name, wr.user_id
       FROM compliance_reports cr JOIN workstation_requests wr ON wr.id = cr.workstation_id
      WHERE cr.workstation_id = $1`,
    [workstationId]
  );
  const ref = res.rows[0];
  if (!ref || (viewer.role !== 'admin' && ref.user_id !== viewer.id)) throw new HttpError(404, 'Compliance report not found');
  return ref;
}

// ---------- Τερματισμός / λήξη ----------

async function terminateWorkstation(workstationId, actor) {
  const res = await pool.query('SELECT * FROM workstation_requests WHERE id = $1', [workstationId]);
  if (res.rows.length === 0) throw new HttpError(404, 'Workstation not found');
  const ws = res.rows[0];

  if (actor.role !== 'admin' && ws.user_id !== actor.id) throw new HttpError(404, 'Workstation not found');
  if (ws.status === 'WAITING_APPROVAL') {
    // Ακύρωση αιτήματος πριν την έγκριση
    await setStatus(ws.id, 'TERMINATED');
    await audit(ws.id, 'REQUEST', 'WORKSTATION-REQUEST', 'CANCELLED', { pod: ws.pod_name }, actor.id);
    return;
  }
  if (!ACTIVE_STATUSES.includes(ws.status)) throw new HttpError(409, `Το workstation είναι ήδη ${ws.status}`);

  if (ws.pod_name) await deleteK8sResources(ws.pod_name);
  await setStatus(ws.id, 'TERMINATED');
  await audit(ws.id, 'TERMINATION', 'LIFECYCLE', 'SUCCESS', { message: 'Workstation terminated', by: actor.email, pod: ws.pod_name }, actor.id);
  console.log(`[LOG] Workstation ${ws.pod_name} terminated by ${actor.email}`);
}

async function expireWorkstation(ws, details) {
  if (ws.pod_name) await deleteK8sResources(ws.pod_name);
  await setStatus(ws.id, 'EXPIRED');
  await audit(ws.id, 'SESSION', 'SESSION-TTL', 'EXPIRED', { sessionTtlHours: SESSION_TTL_HOURS, pod: ws.pod_name, ...details });
  console.log(`[LOG] Session of ${ws.pod_name} expired after ${SESSION_TTL_HOURS}h — Pod, Service & Secret deleted`);
}

// Τερματίζει τα workstations των οποίων η συνεδρία ξεπέρασε το SESSION_TTL_HOURS (από την έγκριση).
async function expireSessions() {
  const expired = await pool.query(
    `SELECT id, pod_name FROM workstation_requests
      WHERE status = 'RUNNING' AND COALESCE(started_at, created_at) < NOW() - make_interval(secs => $1)`,
    [SESSION_TTL_SECONDS]
  );
  for (const ws of expired.rows) {
    try {
      await expireWorkstation(ws, { message: 'Session time limit reached' });
    } catch (err) {
      console.error(`[ERROR] Expiring ${ws.pod_name} failed:`, describeK8sError(err));
    }
  }
  return expired.rows.length;
}

let sweepInProgress = false;

// Τρέχει μία φορά στην εκκίνηση και μετά περιοδικά: λήξη συνεδριών workstations + διαγραφή ληγμένων login sessions.
function startSessionSweeper(extraTasks = []) {
  const sweep = async () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    try {
      await expireSessions();
      for (const task of extraTasks) await task();
    } catch (err) {
      console.error('[WARN] Session sweep failed:', describeK8sError(err));
    } finally {
      sweepInProgress = false;
    }
  };
  sweep();
  setInterval(sweep, SESSION_SWEEP_INTERVAL_MS);
  console.log(`[SESSION] Workstation sessions expire after ${SESSION_TTL_HOURS}h (checked every ${SESSION_SWEEP_INTERVAL_MS / 1000}s)`);
}

// Συγχρονίζει τη βάση με την πραγματική κατάσταση του cluster
// (π.χ. Pods που σβήστηκαν με kubectl ή χάθηκαν μετά από reboot).
async function reconcileWithCluster() {
  // Ο έλεγχος για "κολλημένα" αιτήματα γίνεται στη βάση, ώστε να μην εξαρτάται από τη ζώνη ώρας του Node.
  const active = await pool.query(
    `SELECT id, pod_name, status,
            COALESCE(started_at, created_at) < NOW() - make_interval(secs => $2) AS is_stale
       FROM workstation_requests WHERE status = ANY($1)`,
    [ACTIVE_STATUSES, Math.round(READY_TIMEOUT_MS / 1000) + 60]
  );
  if (active.rows.length === 0) return;

  const podList = await k8sCoreApi.listNamespacedPod({ namespace: k8sNamespace });
  const podsByName = new Map(podList.items.map((p) => [p.metadata.name, p]));

  for (const ws of active.rows) {
    const pod = podsByName.get(ws.pod_name);

    // Αιτήματα σε εξέλιξη τα αφήνουμε, εκτός αν κόλλησαν (π.χ. restart του Manager στη μέση).
    if (ws.status !== 'RUNNING') {
      if (ws.is_stale) {
        await deleteK8sResources(ws.pod_name).catch(() => {});
        await setStatus(ws.id, 'FAILED');
        await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'FAILED', { error: `Request stuck in ${ws.status}` });
      }
      continue;
    }

    if (!pod) {
      await deleteK8sResources(ws.pod_name).catch(() => {}); // Service/Secret που μπορεί να έμειναν
      await setStatus(ws.id, 'TERMINATED');
      await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'TERMINATED', { message: 'Pod no longer exists in cluster' });
      continue;
    }
    // Το kubelet τερμάτισε το Pod λόγω activeDeadlineSeconds (δίχτυ ασφαλείας της συνεδρίας).
    if (pod.status && pod.status.phase === 'Failed' && pod.status.reason === 'DeadlineExceeded') {
      await expireWorkstation(ws, { message: 'Pod stopped by Kubernetes (activeDeadlineSeconds)' });
      continue;
    }
    const fatalReason = getFatalWaitingReason(pod);
    if (fatalReason) {
      await deleteK8sResources(ws.pod_name).catch(() => {});
      await setStatus(ws.id, 'FAILED');
      await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'FAILED', { error: fatalReason });
    }
  }
}

module.exports = {
  HttpError,
  SESSION_TTL_HOURS,
  SESSION_TTL_SECONDS,
  audit,
  createRequest,
  approveRequest,
  rejectRequest,
  terminateWorkstation,
  getWorkstation,
  listWorkstations,
  listPendingApprovals,
  countPendingApprovals,
  toApiWorkstation,
  getComplianceReportRef,
  reconcileWithCluster,
  expireSessions,
  startSessionSweeper,
  describeK8sError,
};
