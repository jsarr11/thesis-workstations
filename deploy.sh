#!/bin/bash
echo "=== [CD] Starting Deployment on Proxmox VM ==="

# 1. Μετάβαση στον φάκελο του Manager
cd ~/thesis-workstations/manager || exit 1

# 2. Τράβηγμα του νέου κώδικα από το GitHub
git pull origin main

# 3. Εγκατάσταση νέων βιβλιοθηκών (αν προστέθηκαν)
npm install

# 4. Επανεκκίνηση του Node.js Server μέσω PM2
pm2 restart manager

# 5. Έλεγχος & Εισαγωγή ΕΤΟΙΜΩΝ Images στο K3s
echo "=== Checking and Importing Local Images to K3s ==="
IMAGES=(
  "workstation-base:latest"
  "workstation-profile:developer"
  "workstation-profile:data-analyst"
  "workstation-profile:devops"
)

for img in "${IMAGES[@]}"; do
  # Ελέγχει αν το image υπάρχει ήδη έτοιμο στο τοπικό Docker engine
  if sudo docker image inspect "$img" >/dev/null 2>&1; then
    echo "[+] Βρέθηκε το $img στο Docker. Μεταφορά στο K3s containerd (namespace k8s.io)..."
    sudo docker save "$img" | sudo k3s ctr -n k8s.io images import -
  else
    echo "[-] Προσοχή: Το image $img ΔΕΝ βρέθηκε στο Docker. Αγνοείται."
  fi
done

echo "=== [CD] Deployment Completed Successfully! ==="

# test line 3