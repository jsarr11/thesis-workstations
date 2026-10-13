const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
require('dotenv').config();

// Lifecycle των workstations στο k3s (χρησιμοποιεί τον Kubernetes client)
const workstations = require('./workstations');
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

// 5. POST /api/workstations/request - Δημιουργία workstation στο k3s
app.post('/api/workstations/request', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const profileId = Number.parseInt(req.body.profile_id, 10);

  if (!workstations.USERNAME_PATTERN.test(username)) {
    return res.status(400).json({
      error: 'Μη έγκυρο username: μόνο πεζά λατινικά, αριθμοί και παύλα (-), έως 30 χαρακτήρες.',
    });
  }
  if (!Number.isInteger(profileId)) {
    return res.status(400).json({ error: 'Μη έγκυρο profile' });
  }

  try {
    const profileRes = await pool.query('SELECT id, image_tag FROM profiles WHERE id = $1', [profileId]);
    if (profileRes.rows.length === 0) {
      return res.status(400).json({ error: 'Profile not found' });
    }

    const workstation = await workstations.provisionWorkstation({
      username,
      profile: profileRes.rows[0],
      clientIp: req.ip || '127.0.0.1',
      // Αν δεν οριστεί PUBLIC_HOST, χρησιμοποιείται η διεύθυνση με την οποία ο χρήστης άνοιξε το portal
      publicHost: process.env.PUBLIC_HOST || req.hostname,
    });
    res.json({ success: true, data: workstation });
  } catch (err) {
    res.status(500).json({ error: `Η δημιουργία απέτυχε: ${err.message}` });
  }
});

// 6. DELETE /api/workstations/:id - Τερματισμός workstation (Pod + Service)
app.delete('/api/workstations/:id', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(404).json({ error: 'Workstation not found' });
  }
  try {
    const ws = await workstations.terminateWorkstation(req.params.id);
    if (!ws) return res.status(404).json({ error: 'Workstation not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[ERROR] Terminate failed:', workstations.describeK8sError(err));
    res.status(500).json({ error: 'Failed to terminate workstation' });
  }
});

// 7. GET /api/workstations - Λίστα Workstations (συγχρονισμένη με το cluster)
app.get('/api/workstations', async (req, res) => {
  try {
    await workstations.reconcileWithCluster().catch((err) =>
      console.error('[WARN] Reconcile with cluster failed:', workstations.describeK8sError(err))
    );
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

// 8. GET /api/audit-logs - Ιστορικό Ελέγχων
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
  console.log(`[SERVER] Manager API & Frontend UI running on port ${PORT}`);
});
