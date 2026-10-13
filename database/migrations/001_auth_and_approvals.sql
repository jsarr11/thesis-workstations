-- 001: Χρήστες, sessions, ροή έγκρισης αιτημάτων, actor στα audit logs, token workstation.
-- Εφαρμόζεται αυτόματα από τον Manager στην εκκίνηση (manager/migrate.js), μία φορά.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    username VARCHAR(30) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'developer')),
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (username);

-- Στη βάση αποθηκεύεται μόνο το SHA-256 hash του session token, ποτέ το ίδιο το token.
CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    client_ip VARCHAR(45),
    user_agent VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);

ALTER TABLE workstation_requests
    ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reviewed_by INT REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS review_note TEXT,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,          -- από εδώ μετρά η διάρκεια της συνεδρίας
    ADD COLUMN IF NOT EXISTS access_token VARCHAR(64);      -- connection token του VS Code (μόνο κάτοχος + admin)

-- Παλιά workstations (πριν την έγκριση): η συνεδρία μετρά από τη δημιουργία τους.
UPDATE workstation_requests SET started_at = created_at WHERE started_at IS NULL AND status <> 'WAITING_APPROVAL';

CREATE INDEX IF NOT EXISTS workstation_requests_status_idx ON workstation_requests (status);

ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS actor_user_id INT REFERENCES users(id) ON DELETE SET NULL;
