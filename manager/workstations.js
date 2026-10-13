// Workstation lifecycle στο k3s: deploy, αναμονή μέχρι Ready, διαγραφή και συγχρονισμός με τη βάση.
const pool = require('./db');
const { k8sCoreApi, k8sNamespace } = require('./k8s');

const READY_TIMEOUT_MS = parseInt(process.env.POD_READY_TIMEOUT_MS || '120000', 10);
const POLL_INTERVAL_MS = 2000;
const ACTIVE_STATUSES = ['PENDING', 'DEPLOYING', 'RUNNING'];

// Kubernetes object names: DNS-1123 (πεζά, αριθμοί, παύλα). Κρατάμε περιθώριο για το suffix "-xxxx-svc".
const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

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

function buildManifests(podName, imageTag) {
  // Baseline ("γυμνό") manifest — χωρίς hardening. Η Φάση 2 θα το διορθώνει (auto-remediation).
  const podManifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      labels: { app: podName, 'managed-by': 'thesis-manager' },
    },
    spec: {
      containers: [{
        name: 'workspace',
        image: imageTag,
        imagePullPolicy: 'Never', // Τα images γίνονται import απευθείας στο containerd του k3s
        ports: [{ containerPort: 3000 }],
      }],
    },
  };

  const serviceManifest = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${podName}-svc`,
      labels: { app: podName, 'managed-by': 'thesis-manager' },
    },
    spec: {
      type: 'NodePort',
      selector: { app: podName },
      ports: [{ port: 3000, targetPort: 3000 }],
    },
  };

  return { podManifest, serviceManifest };
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
  ];
  const results = await Promise.allSettled(deletions);
  for (const r of results) {
    if (r.status === 'rejected' && !isNotFound(r.reason)) throw r.reason;
  }
}

async function audit(workstationId, stage, rule, status, details) {
  await pool.query(
    `INSERT INTO audit_logs (workstation_id, stage, rule_evaluated, status, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [workstationId, stage, rule, status, JSON.stringify(details)]
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
    [workstationId, status, extra.pod_ip || null, extra.access_url || null, ['TERMINATED', 'FAILED'].includes(status)]
  );
}

// Ολόκληρη η ροή δημιουργίας. Στη Φάση 2 τα Steps 1 και 3 θα γίνουν πραγματικοί έλεγχοι.
async function provisionWorkstation({ username, profile, clientIp, publicHost }) {
  const podName = `workstation-${username}-${Date.now().toString().slice(-4)}`;

  const inserted = await pool.query(
    `INSERT INTO workstation_requests (username, client_ip, profile_id, status, pod_name)
     VALUES ($1, $2, $3, 'PENDING', $4) RETURNING id`,
    [username, clientIp, profile.id, podName]
  );
  const workstationId = inserted.rows[0].id;
  let k8sObjectsCreated = false;

  try {
    console.log(`[LOG] Step 1: Image Validation (${profile.image_tag}) — skipped in Phase 1`);

    console.log('[LOG] Step 2: Manifest Generation (baseline, un-hardened)');
    const { podManifest, serviceManifest } = buildManifests(podName, profile.image_tag);

    console.log('[LOG] Step 3: Admission Gate — skipped in Phase 1');

    console.log(`[LOG] Step 4: Deploy Pod & Service ${podName} -> namespace ${k8sNamespace}`);
    await setStatus(workstationId, 'DEPLOYING');
    k8sObjectsCreated = true;
    await k8sCoreApi.createNamespacedPod({ namespace: k8sNamespace, body: podManifest });
    const svc = await k8sCoreApi.createNamespacedService({ namespace: k8sNamespace, body: serviceManifest });
    const nodePort = svc.spec.ports[0].nodePort;

    console.log(`[LOG] Step 5: Waiting for Pod readiness (timeout ${READY_TIMEOUT_MS / 1000}s)`);
    const pod = await waitForPodReady(podName);

    const access_url = `http://${publicHost}:${nodePort}/?folder=/home/workspace`;
    await setStatus(workstationId, 'RUNNING', { pod_ip: pod.status.podIP, access_url });
    await audit(workstationId, 'PROVISIONING', 'BASELINE-DEPLOY', 'SUCCESS', {
      message: 'Unhardened workstation deployed to k3s',
      image: profile.image_tag,
      nodePort,
      podIP: pod.status.podIP,
    });
    console.log(`[LOG] Workstation ${podName} is Ready at ${access_url}`);

    const result = await pool.query('SELECT * FROM workstation_requests WHERE id = $1', [workstationId]);
    return result.rows[0];
  } catch (err) {
    const reason = describeK8sError(err);
    console.error(`[ERROR] Provisioning ${podName} failed: ${reason}`);
    if (k8sObjectsCreated) {
      await deleteK8sResources(podName).catch((e) => console.error('[ERROR] Cleanup failed:', describeK8sError(e)));
    }
    await setStatus(workstationId, 'FAILED');
    await audit(workstationId, 'PROVISIONING', 'BASELINE-DEPLOY', 'FAILED', { error: reason });
    const wrapped = new Error(reason);
    wrapped.workstationId = workstationId;
    throw wrapped;
  }
}

async function terminateWorkstation(workstationId) {
  const res = await pool.query('SELECT * FROM workstation_requests WHERE id = $1', [workstationId]);
  if (res.rows.length === 0) return null;
  const ws = res.rows[0];

  if (ws.pod_name) await deleteK8sResources(ws.pod_name);
  await setStatus(ws.id, 'TERMINATED');
  await audit(ws.id, 'TERMINATION', 'LIFECYCLE', 'SUCCESS', { message: 'Workstation terminated by user/admin', pod: ws.pod_name });
  console.log(`[LOG] Workstation ${ws.pod_name} terminated`);
  return ws;
}

// Συγχρονίζει τη βάση με την πραγματική κατάσταση του cluster
// (π.χ. Pods που σβήστηκαν με kubectl ή χάθηκαν μετά από reboot).
async function reconcileWithCluster() {
  const active = await pool.query(
    'SELECT id, pod_name, status, created_at FROM workstation_requests WHERE status = ANY($1)',
    [ACTIVE_STATUSES]
  );
  if (active.rows.length === 0) return;

  const podList = await k8sCoreApi.listNamespacedPod({ namespace: k8sNamespace });
  const podsByName = new Map(podList.items.map((p) => [p.metadata.name, p]));
  const staleBefore = Date.now() - READY_TIMEOUT_MS - 60000;

  for (const ws of active.rows) {
    const pod = podsByName.get(ws.pod_name);

    // Αιτήματα σε εξέλιξη τα αφήνουμε, εκτός αν κόλλησαν (π.χ. restart του Manager στη μέση).
    if (ws.status !== 'RUNNING') {
      if (new Date(ws.created_at).getTime() < staleBefore) {
        if (pod) await deleteK8sResources(ws.pod_name).catch(() => {});
        await setStatus(ws.id, 'FAILED');
        await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'FAILED', { error: `Request stuck in ${ws.status}` });
      }
      continue;
    }

    if (!pod) {
      await setStatus(ws.id, 'TERMINATED');
      await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'TERMINATED', { message: 'Pod no longer exists in cluster' });
      continue;
    }
    const fatalReason = getFatalWaitingReason(pod);
    if (fatalReason) {
      await setStatus(ws.id, 'FAILED');
      await audit(ws.id, 'RECONCILE', 'LIFECYCLE', 'FAILED', { error: fatalReason });
    }
  }
}

module.exports = {
  USERNAME_PATTERN,
  provisionWorkstation,
  terminateWorkstation,
  reconcileWithCluster,
  describeK8sError,
};
