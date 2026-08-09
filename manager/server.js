const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

// Φορτώνουμε τον Kubernetes Client
const k8sClient = require('./k8s');
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Σερβίρισμα στατικών αρχείων από τον φάκελο public
app.use(express.static(path.join(__dirname, 'public')));

// 1. Healthcheck Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'UP', message: 'Manager Glue Layer is running' });
});

// 2. GET /api/profiles - Φέρνει τα profiles από τη βάση
app.get('/api/profiles', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM profiles ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching profiles' });
  }
});

// 3. GET /api/policies - Φέρνει τους κανόνες ασφαλείας
app.get('/api/policies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pr.*, p.display_name as profile_name 
      FROM policy_rules pr
      JOIN profiles p ON pr.profile_id = p.id
      ORDER BY pr.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching policies' });
  }
});

// 4. POST /api/policies/toggle - Ενεργοποίηση/Απενεργοποίηση Κανόνα από Admin
app.post('/api/policies/toggle', async (req, res) => {
  const { rule_id, is_enabled } = req.body;
  try {
    await pool.query('UPDATE policy_rules SET is_enabled = $1, updated_at = NOW() WHERE id = $2', [is_enabled, rule_id]);
    res.json({ success: true, message: 'Policy status updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update policy' });
  }
});

// 5. POST /api/workstations/request - REAL PROVISIONING (K3s Deployment)
app.post('/api/workstations/request', async (req, res) => {
  const { username, profile_id } = req.body;
  const client_ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  try {
    // 1. Βρίσκουμε το image tag από τη βάση
    const profileRes = await pool.query('SELECT image_tag FROM profiles WHERE id = $1', [profile_id]);
    if (profileRes.rows.length === 0) {
      return res.status(400).json({ error: 'Profile not found' });
    }
    const imageTag = profileRes.rows[0].image_tag;

    // Δημιουργούμε το μοναδικό όνομα του Pod
    const podName = `workstation-${username.toLowerCase()}-${Date.now().toString().slice(-4)}`;

    // 2. Το "Γυμνό" Pod Manifest (Απροστάτευτο baseline)
    const podManifest = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { 
        name: podName, 
        labels: { app: podName } 
      },
      spec: {
        containers: [{
          name: 'workspace',
          image: imageTag, // Π.χ. workstation-profile:developer
          imagePullPolicy: 'Never', // Έχουμε κάνει ήδη import τα images στο containerd
          ports: [{ containerPort: 3000 }]
        }]
      }
    };

    // 3. Το Service Manifest (Για να βγάλουμε το web UI του VS Code προς τα έξω)
    const serviceManifest = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: `${podName}-svc` },
      spec: {
        type: 'NodePort',
        selector: { app: podName },
        ports: [{ port: 3000, targetPort: 3000 }]
      }
    };

    // 4. Αποστολή αιτημάτων στο k3s με τα σωστά ορίσματα στη σειρά
    console.log(`[K8s] Deploying Pod ${podName} in namespace: ${k8sClient.k8sNamespace}...`);
    console.log('[DEBUG] Namespace variable type:', typeof k8sClient.k8sNamespace, 'Value:', k8sClient.k8sNamespace);
    
    await k8sClient.k8sCoreApi.createNamespacedPod(
        k8sClient.k8sNamespace,  // 1ο όρισμα: Το Namespace ('default')
        podManifest              // 2ο όρισμα: Το αντικείμενο του Pod
    );

    console.log(`[K8s] Creating Service ${podName}-svc...`);
    
    await k8sClient.k8sCoreApi.createNamespacedService(
        k8sClient.k8sNamespace,  // 1ο όρισμα: Το Namespace ('default')
        serviceManifest          // 2ο όρισμα: Το αντικείμενο του Service
    );

    // 5. Λήψη του τυχαίου NodePort που άνοιξε το k3s και δημιουργία του URL
    const nodePort = svcResponse.body.spec.ports[0].nodePort;
    const access_url = `http://192.168.1.248:${nodePort}/?folder=/home/workspace`;

    // 6. Καταγραφή στη Βάση Δεδομένων
    const result = await pool.query(
      `INSERT INTO workstation_requests (username, client_ip, profile_id, status, pod_name, access_url)
       VALUES ($1, $2, $3, 'RUNNING', $4, $5) RETURNING *`,
      [username, client_ip, profile_id, podName, access_url]
    );

    // 7. Καταγραφή στο Audit Log (ότι σηκώθηκε απροστάτευτο)
    await pool.query(
      `INSERT INTO audit_logs (workstation_id, stage, rule_evaluated, status, details)
       VALUES ($1, 'PROVISIONING', 'BASELINE-DEPLOY', 'SUCCESS', $2)`,
      [result.rows[0].id, JSON.stringify({ message: 'Unhardened Workstation deployed to K3s', nodePort })]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[K8s API Error]:', err.response ? JSON.stringify(err.response.body) : err.message);
    res.status(500).json({ error: 'Failed to deploy workstation to cluster' });
  }
});

// 6. GET /api/workstations - Λίστα Ενεργών Workstations
app.get('/api/workstations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT wr.*, p.display_name as profile_name 
      FROM workstation_requests wr
      JOIN profiles p ON wr.profile_id = p.id
      ORDER BY wr.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching workstations' });
  }
});

// 7. GET /api/audit-logs - Ιστορικό Ελέγχων
app.get('/api/audit-logs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT al.*, wr.username, wr.pod_name 
      FROM audit_logs al
      JOIN workstation_requests wr ON al.workstation_id = wr.id
      ORDER BY al.timestamp DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching audit logs' });
  }
});

// Δρομολόγηση για τις σελίδες HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`[SERVER] Manager API & Frontend UI running on http://192.168.1.248:${PORT}`);
});
