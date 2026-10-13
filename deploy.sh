#!/bin/bash
# Continuous Deployment στο Proxmox VM (εκτελείται από τον self-hosted GitHub Actions runner).
# Σταματά στο πρώτο σφάλμα, ώστε το GitHub Action να γίνεται κόκκινο όταν κάτι αποτύχει.
set -euo pipefail

REPO_DIR="$HOME/thesis-workstations"
MANAGER_DIR="$REPO_DIR/manager"
PROFILE_IMAGES=(
  "workstation-profile:developer"
  "workstation-profile:data-analyst"
  "workstation-profile:devops"
)

echo "=== [CD] Starting Deployment on Proxmox VM ==="

# 1. Τράβηγμα του νέου κώδικα από το GitHub (αποτυγχάνει αν υπάρχουν τοπικές αλλαγές στο VM)
cd "$REPO_DIR"
git pull --ff-only origin main
echo "[+] Code at commit: $(git log -1 --oneline)"

# 2. Το .env υπάρχει μόνο στο VM (δεν είναι στο git)
cd "$MANAGER_DIR"
if [ ! -f .env ]; then
  echo "[ERROR] Λείπει το $MANAGER_DIR/.env — δημιούργησέ το από το .env.example"
  exit 1
fi

# 3. Εγκατάσταση εξαρτήσεων ακριβώς όπως ορίζει το package-lock.json
npm ci --omit=dev

# 4. Επανεκκίνηση του Manager μέσω PM2 (ή πρώτη εκκίνηση αν δεν υπάρχει)
if pm2 describe manager >/dev/null 2>&1; then
  pm2 restart manager --update-env
else
  pm2 start server.js --name manager
fi
pm2 save

# 5. Import στο k3s μόνο των images που λείπουν (FORCE_IMAGE_IMPORT=1 για εξαναγκασμένο import)
echo "=== Checking workstation images in k3s ==="
if sudo -n true 2>/dev/null; then
  K3S_IMAGES="$(sudo -n k3s ctr -n k8s.io images ls -q)"
  for img in "${PROFILE_IMAGES[@]}"; do
    if [ "${FORCE_IMAGE_IMPORT:-0}" != "1" ] && grep -qx "docker.io/library/$img" <<< "$K3S_IMAGES"; then
      echo "[=] $img υπάρχει ήδη στο k3s"
    elif sudo -n docker image inspect "$img" >/dev/null 2>&1; then
      echo "[+] Import του $img στο k3s containerd (namespace k8s.io)..."
      sudo -n docker save "$img" | sudo -n k3s ctr -n k8s.io images import -
    else
      echo "[!] ΠΡΟΣΟΧΗ: Το $img λείπει από το k3s ΚΑΙ από το Docker — χρειάζεται docker build"
    fi
  done
else
  echo "[!] Δεν υπάρχει passwordless sudo για τον runner — παραλείπεται ο έλεγχος images"
fi

# 6. Health check: το deployment θεωρείται επιτυχές μόνο αν ο Manager απαντά
PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-5000}"
for i in $(seq 1 15); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "[+] Manager health check OK (port $PORT)"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "[ERROR] Ο Manager δεν απαντά στο /api/health — δες: pm2 logs manager"
    exit 1
  fi
  sleep 2
done

# 7. Προειδοποίηση για τον δίσκο (το k3s σβήνει images όταν ο δίσκος γεμίζει)
DISK_USE="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "$DISK_USE" -ge 80 ]; then
  echo "[!] ΠΡΟΣΟΧΗ: Ο δίσκος είναι στο ${DISK_USE}% — το k3s μπορεί να σβήσει workstation images"
fi

echo "=== [CD] Deployment Completed Successfully! ==="
