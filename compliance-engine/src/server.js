// HTTP API του Compliance Engine (Node.js http, χωρίς εξωτερικές βιβλιοθήκες).
//   GET  /health        δημόσιο
//   GET  /rules         κατάλογος κανόνων                              (API key)
//   POST /evaluate      { manifest, rules, context } → report + manifest (API key)
//   GET  /reports/:id   το αποθηκευμένο report, αυτούσιο                (API key)
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { evaluate } = require('./engine');
const { createStore } = require('./store');
const { UnsupportedManifestError } = require('./workload');
const { RULES, RULESET_VERSION, describeRule } = require('./rules');
const { version: ENGINE_VERSION } = require('../package.json');

const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Σύγκριση σταθερού χρόνου (μέσω hash, ώστε να μη διαρρέει ούτε το μήκος του key)
function isAuthorized(req, apiKey) {
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(apiKey).digest();
  return provided.length > 0 && crypto.timingSafeEqual(a, b);
}

function createServer(config) {
  const store = createStore(config.dataDir);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'UP', engine: ENGINE_VERSION, ruleset: RULESET_VERSION, rules: RULES.map((r) => r.id) });
    }
    if (!isAuthorized(req, config.apiKey)) throw new HttpError(401, 'Invalid or missing API key');

    if (req.method === 'GET' && url.pathname === '/rules') {
      return sendJson(res, 200, { ruleset_version: RULESET_VERSION, rules: RULES.map(describeRule) });
    }

    if (req.method === 'POST' && url.pathname === '/evaluate') {
      const body = await readJsonBody(req);
      if (!body.manifest) throw new HttpError(400, 'Field "manifest" is required');
      if (body.rules !== undefined && !Array.isArray(body.rules)) throw new HttpError(400, 'Field "rules" must be an array');
      if (body.context !== undefined && (typeof body.context !== 'object' || Array.isArray(body.context))) {
        throw new HttpError(400, 'Field "context" must be an object');
      }
      let result;
      try {
        result = evaluate({ manifest: body.manifest, rules: body.rules || [], context: body.context || {} });
      } catch (err) {
        if (err instanceof UnsupportedManifestError) throw new HttpError(422, err.message);
        throw err;
      }
      const { report, manifest } = result;
      const reportSha256 = store.saveReport(report);
      console.log(`[ENGINE] ${report.decision} ${report.subject.kind}/${report.subject.name || '-'} report=${report.report_id} `
        + `remediated=${report.summary.remediated} blocked=${report.summary.blocked} not_enforced=${report.summary.violations_not_enforced}`);
      return sendJson(res, 200, {
        report_id: report.report_id,
        report_sha256: reportSha256,
        decision: report.decision,
        compliant: report.compliant,
        summary: report.summary,
        rules: report.rules.map((r) => ({ rule: r.rule, enabled: r.enabled, outcome: r.outcome })),
        manifest,
      });
    }

    const reportMatch = url.pathname.match(/^\/reports\/([^/]+)$/);
    if (req.method === 'GET' && reportMatch) {
      const data = store.readReport(reportMatch[1]);
      if (!data) throw new HttpError(404, 'Report not found');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      return res.end(data);
    }

    throw new HttpError(404, 'Not found');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error('[ENGINE][ERROR]', req.method, req.url, err);
      return sendJson(res, 500, { error: 'Internal error' });
    });
  });
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[ENGINE][CRITICAL] ${err.message}`);
    process.exit(1);
  }
  createServer(config).listen(config.port, config.host, () => {
    console.log(`[ENGINE] Compliance Engine ${ENGINE_VERSION} (ruleset ${RULESET_VERSION}) on http://${config.host}:${config.port} — data: ${config.dataDir}`);
  });
}

module.exports = { createServer };
