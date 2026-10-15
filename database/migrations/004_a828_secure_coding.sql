-- 004: Ο κανόνας A.8.28 Secure coding του Compliance Engine στο Policy Checklist κάθε profile (προεπιλογή ON).
-- Το engine ζητά runAsNonRoot: true (αυτόματη διόρθωση) και μπλοκάρει ρητό root· το UID το ορίζει το image (USER 1000).

INSERT INTO policy_rules (profile_id, rule_key, description, iso_control, is_enabled)
SELECT p.id,
       'A.8.28',
       'Secure coding: τα containers τρέχουν χωρίς δικαιώματα root (runAsNonRoot: true), χωρίς runAsUser: 0 και χωρίς runAsNonRoot: false',
       'ISO 27001 A.8.28 · CIS K8s v1.8 5.2.7',
       TRUE
  FROM profiles p
ON CONFLICT (profile_id, rule_key) DO NOTHING;
