// Πυρήνας: αξιολόγηση ενός manifest απέναντι στους κανόνες, αυτόματη διόρθωση όσων επιτρέπεται και παραγωγή
// του compliance report. Δεν ξέρει τίποτα για την πλατφόρμα που τον καλεί, ούτε αποθηκεύει κάτι.
const crypto = require('crypto');
const { RULES, RULESET_VERSION, describeRule } = require('./rules');
const { getPodSpec } = require('./workload');
const { canonicalJson, sha256 } = require('./canonical');
const { version: ENGINE_VERSION } = require('../package.json');

// Αποτέλεσμα ανά έλεγχο
const CHECK = {
  PASS: 'PASS',                                       // συμμορφώνεται ήδη
  REMEDIATED: 'REMEDIATED',                           // διορθώθηκε αυτόματα
  BLOCKED: 'BLOCKED',                                 // δεν διορθώνεται → απαγορεύεται το deployment
  VIOLATION_NOT_ENFORCED: 'VIOLATION_NOT_ENFORCED',   // παράβαση, αλλά ο κανόνας είναι απενεργοποιημένος
};

// Αποτέλεσμα ανά κανόνα
function ruleOutcome(enabled, checks) {
  const has = (status) => checks.some((c) => c.status === status);
  if (!enabled) return has(CHECK.VIOLATION_NOT_ENFORCED) ? 'DISABLED_VIOLATIONS_FOUND' : 'DISABLED_NO_VIOLATIONS';
  if (has(CHECK.BLOCKED)) return 'BLOCKED';
  if (has(CHECK.REMEDIATED)) return 'REMEDIATED';
  return 'COMPLIANT';
}

// Οι ρυθμίσεις του καλούντος για έναν κανόνα: { id, enabled, changed_by, changed_at }
function selectionFor(ruleId, selections) {
  const s = selections.find((r) => r && r.id === ruleId);
  return {
    enabled: Boolean(s && s.enabled === true),
    provided: Boolean(s),
    changed_by: s && s.changed_by ? String(s.changed_by) : null,
    changed_at: s && s.changed_at ? String(s.changed_at) : null,
  };
}

function evaluate({ manifest, rules: selections = [], context = {} }) {
  const working = structuredClone(manifest);
  const spec = getPodSpec(working);
  const manifestBefore = sha256(canonicalJson(manifest));

  const ruleResults = RULES.map((rule) => {
    const selection = selectionFor(rule.id, selections);
    const checks = [];
    for (const check of rule.checks) {
      for (const finding of check.evaluate(spec)) {
        const entry = {
          check: check.id,
          title: check.title,
          target: finding.target,
          ...(finding.container ? { container: finding.container } : {}),
          ...(finding.volume ? { volume: finding.volume } : {}),
          before: finding.actual,
          expected: finding.expected,
        };
        if (finding.compliant) {
          entry.status = CHECK.PASS;
        } else if (!selection.enabled) {
          entry.status = CHECK.VIOLATION_NOT_ENFORCED;
        } else if (check.remediation === 'auto' && finding.fix) {
          entry.after = finding.fix();
          entry.status = CHECK.REMEDIATED;
        } else {
          entry.status = CHECK.BLOCKED;
        }
        if (finding.reason && entry.status !== CHECK.PASS) entry.reason = finding.reason;
        checks.push(entry);
      }
    }
    return {
      rule: rule.id,
      title: rule.title,
      iso: rule.iso,
      source: rule.source,
      enabled: selection.enabled,
      ...(selection.provided ? { setting_changed_by: selection.changed_by, setting_changed_at: selection.changed_at } : {}),
      outcome: ruleOutcome(selection.enabled, checks),
      checks,
    };
  });

  const allChecks = ruleResults.flatMap((r) => r.checks);
  const count = (status) => allChecks.filter((c) => c.status === status).length;
  const compliant = count(CHECK.BLOCKED) === 0;
  const knownIds = new Set(RULES.map((r) => r.id));

  const report = {
    report_type: 'compliance-evaluation',
    schema_version: 1,
    report_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    engine: { name: 'compliance-engine', version: ENGINE_VERSION, ruleset_version: RULESET_VERSION },
    subject: {
      kind: manifest.kind,
      name: manifest.metadata && manifest.metadata.name ? manifest.metadata.name : null,
      namespace: manifest.metadata && manifest.metadata.namespace ? manifest.metadata.namespace : null,
      context,
    },
    decision: compliant ? 'ALLOW' : 'DENY',
    compliant,
    summary: {
      rules_enabled: ruleResults.filter((r) => r.enabled).map((r) => r.rule),
      rules_disabled: ruleResults.filter((r) => !r.enabled).map((r) => r.rule),
      checks_total: allChecks.length,
      passed: count(CHECK.PASS),
      remediated: count(CHECK.REMEDIATED),
      blocked: count(CHECK.BLOCKED),
      violations_not_enforced: count(CHECK.VIOLATION_NOT_ENFORCED),
    },
    rules: ruleResults,
    unknown_rules: selections.filter((s) => s && s.id && !knownIds.has(s.id)).map((s) => s.id),
    manifest: {
      sha256_before: manifestBefore,
      sha256_after: sha256(canonicalJson(working)),
      changed: count(CHECK.REMEDIATED) > 0,
    },
    ruleset: RULES.map(describeRule),
  };

  return { report, manifest: working };
}

module.exports = { evaluate, CHECK };
