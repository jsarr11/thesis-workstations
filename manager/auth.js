// Authentication & authorization: κωδικοί (scrypt), sessions (cookie), έλεγχος ρόλων, όριο αποτυχημένων login.
const crypto = require('crypto');
const { promisify } = require('util');
const pool = require('./db');

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'ws_session';
const LOGIN_SESSION_HOURS = Number.parseFloat(process.env.LOGIN_SESSION_HOURS || '12');
// Σε HTTPS (π.χ. στο cloud) βάλε COOKIE_SECURE=true, ώστε το cookie να μη στέλνεται ποτέ σε HTTP.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MIN_PASSWORD_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const ROLES = ['admin', 'developer'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Το username γίνεται μέρος του ονόματος του Pod: DNS-1123 (πεζά, αριθμοί, παύλα), έως 30 χαρακτήρες.
const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

// ---------- Κωδικοί ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Χρησιμοποιείται όταν το email δεν υπάρχει, ώστε ο χρόνος απόκρισης να μη φανερώνει ποια emails υπάρχουν.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

function generatePassword() {
  // 16 χαρακτήρες χωρίς εύκολα μπερδεμένους (0/O, 1/l/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Ο κωδικός πρέπει να έχει τουλάχιστον ${MIN_PASSWORD_LENGTH} χαρακτήρες.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Ο κωδικός πρέπει να περιέχει γράμματα και αριθμούς.';
  }
  return null;
}

// ---------- Sessions ----------

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function sessionCookie(value, maxAgeSeconds) {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    COOKIE_SECURE ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

async function createSession(res, userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = Math.round(LOGIN_SESSION_HOURS * 3600);
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at, client_ip, user_agent)
     VALUES ($1, $2, NOW() + make_interval(secs => $3), $4, $5)`,
    [sha256(token), userId, maxAge, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 255)]
  );
  res.setHeader('Set-Cookie', sessionCookie(token, maxAge));
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [sha256(token)]);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

async function deleteExpiredSessions() {
  await pool.query('DELETE FROM user_sessions WHERE expires_at < NOW()');
}

// Middleware: αν υπάρχει έγκυρο session, ορίζει το req.user.
async function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return next();
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.username, u.role, u.must_change_password
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active`,
      [sha256(token)]
    );
    req.user = result.rows[0] || null;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------- Έλεγχος πρόσβασης ----------
// API: 401/403 σε JSON. Σελίδες: ανακατεύθυνση στο login ή στο portal.

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Απαιτείται σύνδεση' });
  if (req.user.must_change_password && !req.path.startsWith('/api/auth/')) {
    return res.status(403).json({ error: 'Πρέπει πρώτα να αλλάξεις τον κωδικό σου' });
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Δεν έχεις δικαίωμα πρόσβασης (μόνο admin)' });
    next();
  });
}

function pageAuth(role) {
  return (req, res, next) => {
    if (!req.user || req.user.must_change_password) return res.redirect('/login');
    if (role === 'admin' && req.user.role !== 'admin') return res.redirect('/');
    next();
  };
}

// ---------- Όριο αποτυχημένων login (brute-force) ----------

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // key: ip|email → { count, firstAt }

function loginKey(ip, email) {
  return `${ip}|${String(email || '').toLowerCase()}`;
}

function isLoginBlocked(ip, email) {
  const entry = loginFailures.get(loginKey(ip, email));
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(loginKey(ip, email));
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip, email) {
  const key = loginKey(ip, email);
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) loginFailures.set(key, { count: 1, firstAt: Date.now() });
  else entry.count += 1;
}

function clearLoginFailures(ip, email) {
  loginFailures.delete(loginKey(ip, email));
}

module.exports = {
  ROLES,
  EMAIL_PATTERN,
  USERNAME_PATTERN,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  dummyHash,
  generatePassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  deleteExpiredSessions,
  loadUser,
  requireAuth,
  requireAdmin,
  pageAuth,
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
};
