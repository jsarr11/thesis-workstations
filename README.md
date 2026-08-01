# Diploma Thesis: Compliance and Auto-Remediation in On-Demand Cloud-Native Workstations

## 🏗️ Infrastructure & Lab Access Blueprint

### Proxmox Host Access
- **Web UI URL:** `https://192.168.1.100:8006`
- **Root User:** `root`
- **Root Password:** `rootroot`
- **Proxmox Node Shell Command:** `reboot` (for hardware/filesystem recovery)

### Ubuntu Server VM (k3s Node / Workstation Host)
- **VM ID:** `100`
- **Hostname:** `k3s-master`
- **Username:** `root1`
- **Password:** `rootroot1`
- **Network Interface (DHCP IP):** `192.168.1.248/24`
- **Services Enabled:** OpenSSH Server (`sshd`)

### Database Infrastructure (PostgreSQL Container)
- **Container Name:** `thesis-postgres`
- **Database Name:** `thesis_workstations_db`
- **User:** `thesis_admin`
- **Password:** `thesis_password123`
- **Port:** `5432`
- **Storage Volume:** `pgdata`

### Core Technologies
- **Hypervisor:** Proxmox VE
- **Virtualization OS:** Ubuntu Server 22.04.5 LTS (`ubuntu-22.04.5-live-server-amd64.iso`)
- **Container Orchestration:** k3s (Lightweight Kubernetes)
- **Database:** PostgreSQL 15 (Dockerized / Alpine)
- **Application Stack:** Node.js v20 LTS (Manager/Glue Layer, Static UI Server), OpenVSCode Server (Workstation Pods)

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
  - [ ] Build Auto-Remediation Engine (YAML AST Parsing & Mutating)
- [x] **Step 4:** Frontend UI (Admin Checklist & Developer Dashboard)
  - [x] Develop Developer Portal (`index.html`) for Workstation Request form
  - [x] Develop Admin Dashboard (`admin.html`) with dynamic tabs for Policy Checklist, Active Workstations, and Audit Logs
  - [x] Serve interfaces via Express Static router and link to DB endpoints
- [ ] **Step 5:** Testing, Real Provisioning, Trivy Scans & Compliance Audit Logging