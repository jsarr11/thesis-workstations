-- 003: Επανεξέταση του cluster (A.8.9 "reviewed"): παραπομπή σε κάθε CIS scan (kube-bench) του Compliance Engine.
-- Το ίδιο το αποτέλεσμα (cluster-logs) το κρατά το Compliance Engine· εδώ μόνο ID, SHA-256 και σύνοψη.

CREATE TABLE IF NOT EXISTS cluster_scans (
    scan_id UUID PRIMARY KEY,
    report_sha256 CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,              -- COMPLETED | FAILED
    trigger VARCHAR(20) NOT NULL,             -- SCHEDULED | STARTUP | MANUAL
    requested_by INT REFERENCES users(id) ON DELETE SET NULL,
    summary JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS cluster_scans_created_idx ON cluster_scans (created_at DESC);
