// Κατάλογος κανόνων. Κάθε κανόνας είναι ανεξάρτητο module· νέος κανόνας = νέο αρχείο + μία γραμμή εδώ.
const RULESET_VERSION = '0.1.0';

const RULES = [
  require('./a-8-9-configuration-management'),
];

// Περιγραφή χωρίς κώδικα, για το GET /rules και το report.
function describeRule(rule) {
  return {
    id: rule.id,
    title: rule.title,
    iso: rule.iso,
    source: rule.source,
    description: rule.description,
    checks: rule.checks.map((c) => ({ id: c.id, title: c.title, remediation: c.remediation })),
  };
}

module.exports = { RULES, RULESET_VERSION, describeRule };
