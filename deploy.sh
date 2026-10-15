#!/bin/bash
# Continuous Deployment στο Proxmox VM (εκτελείται από τον self-hosted GitHub Actions runner).
# Σταματά στο πρώτο σφάλμα, ώστε το GitHub Action να γίνεται κόκκινο όταν κάτι αποτύχει.
set -euo pipefail

REPO_DIR="$HOME/thesis-workstations"
MANAGER_DIR="$REPO_DIR/manager"
DOCKER_DIR="$REPO_DIR/docker"
BASE_IMAGE="workstation-base:v1"
PROFILES=("developer" "data-analyst" "devops")   # image: workstation-profile:<profile>, Dockerfile.<profile>

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

# 3b. Compliance Engine (ξεχωριστή υπηρεσία, χωρίς npm εξαρτήσεις): ρυθμίσεις, εκκίνηση και health check.
#     Πρέπει να τρέχει πριν από τον Manager: χωρίς αυτό κανένα workstation δεν γίνεται deploy (fail-closed).
ENGINE_DIR="$REPO_DIR/compliance-engine"
env_value() { { grep -E "^$1=" "$2" || true; } | tail -1 | cut -d= -f2- | tr -d '[:space:]'; }

if [ ! -f "$ENGINE_DIR/.env" ]; then
  ENGINE_KEY_NEW="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  ( umask 077; printf 'HOST=127.0.0.1\nPORT=5100\nAPI_KEY=%s\n' "$ENGINE_KEY_NEW" > "$ENGINE_DIR/.env" )
  echo "[+] Δημιουργήθηκε το $ENGINE_DIR/.env με νέο τυχαίο API key"
fi
ENGINE_PORT="$(env_value PORT "$ENGINE_DIR/.env")"; ENGINE_PORT="${ENGINE_PORT:-5100}"
ENGINE_KEY="$(env_value API_KEY "$ENGINE_DIR/.env")"

# Ο Manager χρειάζεται τη διεύθυνση και το ίδιο API key (προστίθενται μόνο αν λείπουν)
[ -n "$(tail -c1 .env)" ] && echo >> .env
if ! grep -q '^COMPLIANCE_ENGINE_URL=' .env; then
  echo "COMPLIANCE_ENGINE_URL=http://127.0.0.1:$ENGINE_PORT" >> .env
  echo "[+] Προστέθηκε το COMPLIANCE_ENGINE_URL στο manager/.env"
fi
if ! grep -q '^COMPLIANCE_ENGINE_API_KEY=' .env; then
  echo "COMPLIANCE_ENGINE_API_KEY=$ENGINE_KEY" >> .env
  echo "[+] Προστέθηκε το COMPLIANCE_ENGINE_API_KEY στο manager/.env"
fi
if [ "$(env_value COMPLIANCE_ENGINE_API_KEY .env)" != "$ENGINE_KEY" ]; then
  echo "[ERROR] Το COMPLIANCE_ENGINE_API_KEY του manager/.env διαφέρει από το API_KEY του compliance-engine/.env"
  exit 1
fi

if pm2 describe compliance-engine >/dev/null 2>&1; then
  pm2 restart compliance-engine --update-env
else
  pm2 start "$ENGINE_DIR/src/server.js" --name compliance-engine --cwd "$ENGINE_DIR"
fi
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$ENGINE_PORT/health" >/dev/null 2>&1; then
    echo "[+] Compliance Engine health check OK (port $ENGINE_PORT)"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "[ERROR] Το Compliance Engine δεν απαντά στο /health — δες: pm2 logs compliance-engine"
    exit 1
  fi
  sleep 1
done

# 4. Επανεκκίνηση του Manager μέσω PM2 (ή πρώτη εκκίνηση αν δεν υπάρχει)
if pm2 describe manager >/dev/null 2>&1; then
  pm2 restart manager --update-env
else
  pm2 start server.js --name manager
fi
pm2 save

# 5. Workstation images: build όσων λείπουν από το Docker και import όσων λείπουν από το k3s
#    (FORCE_IMAGE_IMPORT=1 για εξαναγκασμένο import όλων στο k3s)
docker_has() { sudo -n docker image inspect "$1" >/dev/null 2>&1; }

echo "=== Checking workstation images (Docker & k3s) ==="
# Ελέγχουμε μόνο τις δύο εντολές που χρειαζόμαστε (λειτουργεί και με τον περιορισμένο κανόνα του deploy/runner-sudoers)
if sudo -n docker info >/dev/null 2>&1 && sudo -n k3s ctr version >/dev/null 2>&1; then
  BUILT_ANY=0
  for profile in "${PROFILES[@]}"; do
    img="workstation-profile:$profile"
    if ! docker_has "$img"; then
      if [ "$(df --output=pcent / | tail -1 | tr -dc '0-9')" -ge 80 ]; then
        echo "[ERROR] Ο δίσκος είναι πάνω από 80% — ακυρώνεται το build του $img για να μη γεμίσει ο δίσκος"
        exit 1
      fi
      if ! docker_has "$BASE_IMAGE"; then
        echo "[+] Build του $BASE_IMAGE (λείπει από το Docker)..."
        sudo -n docker build -f "$DOCKER_DIR/Dockerfile.base" -t "$BASE_IMAGE" "$DOCKER_DIR"
      fi
      echo "[+] Build του $img (λείπει από το Docker) — μπορεί να διαρκέσει μερικά λεπτά..."
      sudo -n docker build -f "$DOCKER_DIR/Dockerfile.$profile" -t "$img" "$DOCKER_DIR"
      BUILT_ANY=1
    fi
  done
  if [ "$BUILT_ANY" = "1" ]; then
    sudo -n docker image prune -f >/dev/null   # σβήνει μόνο dangling layers, όχι images με tag
  fi

  K3S_IMAGES="$(sudo -n k3s ctr -n k8s.io images ls -q)"
  for profile in "${PROFILES[@]}"; do
    img="workstation-profile:$profile"
    if [ "${FORCE_IMAGE_IMPORT:-0}" != "1" ] && grep -qx "docker.io/library/$img" <<< "$K3S_IMAGES"; then
      echo "[=] $img υπάρχει ήδη στο k3s"
    else
      echo "[+] Import του $img στο k3s containerd (namespace k8s.io)..."
      sudo -n docker save "$img" | sudo -n k3s ctr -n k8s.io images import -
    fi
  done
else
  echo "[!] Δεν υπάρχει passwordless sudo για τον runner — παραλείπεται ο έλεγχος images (τρέξε το deploy.sh χειροκίνητα)"
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
