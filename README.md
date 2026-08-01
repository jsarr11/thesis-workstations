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

### Core Technologies
- **Hypervisor:** Proxmox VE
- **Virtualization OS:** Ubuntu Server 22.04.5 LTS (`ubuntu-22.04.5-live-server-amd64.iso`)
- **Container Orchestration:** k3s (Lightweight Kubernetes)
- **Application Stack:** Node.js (Manager/Glue Layer), Flutter Web (Frontend UI), OpenVSCode Server (Workstation Pods)

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
- [ ] **Step 3:** Node.js Manager (Glue Layer & Auto-Remediation Engine)
- [ ] **Step 4:** Frontend UI (Admin Checklist & Developer Dashboard)
- [ ] **Step 5:** Testing, Trivy Scans & Compliance Audit Logging