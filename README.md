# Diploma Thesis: Compliance and Auto-Remediation in On-Demand Cloud-Native Workstations

## 🏗️ Infrastructure & Lab Access Blueprint

> Credentials are intentionally **not** stored in this (public) repository. They are kept in the private `info/` notes.

### Proxmox Host Access
- **Web UI URL:** `https://192.168.1.100:8006`

### Ubuntu Server VM (k3s Node / Workstation Host)
- **VM ID:** `100`
- **Hostname:** `k3s-master`
- **SSH:** `ssh root1@192.168.1.248`
- **Network Interface (DHCP IP):** `192.168.1.248/24`
- **Disk:** 30 GB root LV (`ubuntu-vg/ubuntu-lv`) — keep usage below 80%, otherwise k3s garbage-collects the workstation images
- **Services Enabled:** OpenSSH Server (`sshd`), GitHub Actions Self-Hosted Runner, PM2 (`pm2-root1` systemd unit)

### Application URLs
- **Developer Portal:** `http://192.168.1.248:5000`
- **Admin Dashboard:** `http://192.168.1.248:5000/admin`
- **Health Check:** `http://192.168.1.248:5000/api/health`
- **Workstations:** `http://192.168.1.248:<NodePort>/?folder=/home/workspace` (returned by the portal)

### Database Infrastructure (PostgreSQL Container)
- **Container Name:** `thesis-postgres`
- **Database Name:** `thesis_workstations_db`
- **Port:** `5432`
- **Storage Volume:** `pgdata`

### Manager Configuration
- Copy `manager/.env.example` to `manager/.env` on the VM and fill in the values (the `.env` file is not tracked by git).

### Core Technologies
- **Hypervisor:** Proxmox VE
- **Virtualization OS:** Ubuntu Server 22.04.5 LTS (`ubuntu-22.04.5-live-server-amd64.iso`)
- **Container Orchestration:** k3s (Lightweight Kubernetes)
- **Database:** PostgreSQL 15 (Dockerized / Alpine)
- **Application Stack:** Node.js v20 LTS (Manager/Glue Layer, Static UI Server), OpenVSCode Server (Workstation Pods)
- **CI/CD:** GitHub Actions (via local Self-Hosted Runner), PM2 Process Manager

---

## 🗺️ Implementation Roadmap

- [x] **Step 1:** Proxmox VM Setup & k3s Cluster Installation
  - Complete Ubuntu Server OS installation on VM 100
  - Connect via SSH or Proxmox Console (`ssh root1@192.168.1.248`)
  - Install k3s cluster:
    ```bash
    curl -sfL [https://get.k3s.io](https://get.k3s.io) | sh -
    ```
  - Verify cluster status and check nodes:
    ```bash
    sudo kubectl get nodes
    ```
- [x] **Step 2:** Base Image & Profile Dockerfiles
  - Created `Dockerfile.base`, `Dockerfile.developer`, `Dockerfile.data-analyst`, and `Dockerfile.devops`
  - Built Docker images locally on VM 100
  - Resolved containerd import syntax and imported images directly into k3s runtime:
    ```bash
    sudo docker save workstation-profile:<profile> | sudo k3s ctr images import -
    ```
- [x] **Step 3:** Node.js Manager (Glue Layer API)
  - [x] Deploy & initialize PostgreSQL database container with 4 normalized tables (`profiles`, `policy_rules`, `workstation_requests`, `audit_logs`)
  - [x] Upgrade environment to Node.js v20 LTS & Initialize Express API Server with DB connection
  - [x] Implement Kubernetes API Client setup (`k8s.js`) for real k3s provisioning & dynamic Namespace binding
  - [x] Transition from Mock to Real Provisioning (`server.js` integration with `k8sCoreApi` for Pod & NodePort Service deployment)
  - [x] Workstation lifecycle (`workstations.js`): input validation, Pod readiness wait, failure cleanup, terminate endpoint, DB ↔ cluster reconciliation
  - [ ] Build Auto-Remediation Engine (YAML AST Parsing & Mutating)
- [x] **Step 4:** Frontend UI (Admin Checklist & Developer Dashboard)
  - [x] Develop Developer Portal (`index.html`) for Workstation Request form
  - [x] Develop Admin Dashboard (`admin.html`) with dynamic tabs for Policy Checklist, Active Workstations, and Audit Logs
  - [x] Serve interfaces via Express Static router and link to DB endpoints
- [x] **Step 5:** Continuous Deployment (CI/CD) Pipeline
  - [x] Implement local deployment bash script (`deploy.sh`) for Git pulls and PM2 restarts
  - [x] Install and configure GitHub Actions Self-Hosted Runner on VM 100
  - [x] Create `.github/workflows/deploy.yml` configured to target `runs-on: self-hosted`
  - [x] Achieve zero-downtime, fully automated deployments upon code pushes to the `main` branch
- [ ] **Step 6:** Testing, Real Provisioning, Trivy Scans & Compliance Audit Logging