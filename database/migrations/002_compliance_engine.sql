-- 002: Σύνδεση με το Compliance Engine (Φάση 2).
-- Ο κανόνας A.8.9 στο Policy Checklist για κάθε profile, ποιος άλλαξε κάθε κανόνα, και παραπομπή
-- στο compliance report κάθε workstation (το ίδιο το report το κρατά το Compliance Engine).

ALTER TABLE policy_rules
    ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id) ON DELETE SET NULL;

INSERT INTO policy_rules (profile_id, rule_key, description, iso_control, is_enabled)
SELECT p.id,
       'A.8.9',
       'Configuration management: απομόνωση του Pod από τον host (hostPID, hostIPC, hostNetwork), χωρίς privilege escalation (π.χ. sudo), χωρίς hostPath volumes και hostPorts',
       'ISO 27001 A.8.9 · CIS K8s v1.8 5.2.3–5.2.6, 5.2.12, 5.2.13',
       TRUE
  FROM profiles p
ON CONFLICT (profile_id, rule_key) DO NOTHING;

-- Μόνο η παραπομπή: ID, SHA-256 (έλεγχος ακεραιότητας κατά τη λήψη) και η απόφαση του εργαλείου.
CREATE TABLE IF NOT EXISTS compliance_reports (
    workstation_id UUID PRIMARY KEY REFERENCES workstation_requests(id) ON DELETE CASCADE,
    report_id UUID NOT NULL UNIQUE,
    report_sha256 CHAR(64) NOT NULL,
    decision VARCHAR(10) NOT NULL,
    summary JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
