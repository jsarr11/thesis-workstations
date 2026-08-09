-- 1. Create Profiles Table
CREATE TABLE IF NOT EXISTS profiles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    image_tag VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create Policy Rules Table (Admin Settings - Clean & Empty)
CREATE TABLE IF NOT EXISTS policy_rules (
    id SERIAL PRIMARY KEY,
    profile_id INT REFERENCES profiles(id) ON DELETE CASCADE,
    rule_key VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    iso_control VARCHAR(100) NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    custom_value VARCHAR(100),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_profile_rule UNIQUE (profile_id, rule_key)
);

-- 3. Create Workstation Requests Table (Empty - Managed dynamically)
CREATE TABLE IF NOT EXISTS workstation_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) NOT NULL,
    client_ip VARCHAR(45) NOT NULL,
    profile_id INT REFERENCES profiles(id),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    pod_name VARCHAR(150),
    pod_ip VARCHAR(45),
    access_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    terminated_at TIMESTAMP
);

-- 4. Create Audit Logs Table (Empty - Compliance Evidence)
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    workstation_id UUID REFERENCES workstation_requests(id) ON DELETE CASCADE,
    stage VARCHAR(50) NOT NULL,
    rule_evaluated VARCHAR(100) NOT NULL,
    status VARCHAR(30) NOT NULL,
    details JSONB,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert ONLY the 3 Essential Profiles
INSERT INTO profiles (name, display_name, description, image_tag) VALUES
('developer', 'Software Developer', 'Web & App engineering with Node.js, Python, Go', 'workstation-profile:developer'),
('data-analyst', 'Data Analyst', 'Data Science & ML with Jupyter, Pandas, PyTorch', 'workstation-profile:data-analyst'),
('devops', 'DevOps / Cloud Security', 'IaC & Auditing with kubectl, Helm, Terraform, Trivy', 'workstation-profile:devops')
ON CONFLICT (name) DO NOTHING;
