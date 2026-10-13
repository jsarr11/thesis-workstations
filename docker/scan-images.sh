#!/bin/bash
# Pre-baked compliance evidence (Blueprint Βήμα 3.2): σάρωση των workstation images με Trivy.
# Το Trivy τρέχει ως container (δεν εγκαθίσταται στο VM) και διαβάζει τα τοπικά images μέσω του docker.sock.
#
# Χρήση:  bash docker/scan-images.sh [--gate] [image ...]
#   --gate  αποτυγχάνει (exit 1) αν κάποιο image έχει CRITICAL ή HIGH ευπάθειες (κριτήριο "0 Critical / 0 High")
set -euo pipefail

TRIVY_IMAGE="aquasec/trivy:0.75.0"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$REPO_DIR/reports/$(date +%F)"
GATE=0
IMAGES=()

for arg in "$@"; do
  case "$arg" in
    --gate) GATE=1 ;;
    *) IMAGES+=("$arg") ;;
  esac
done
if [ "${#IMAGES[@]}" -eq 0 ]; then
  IMAGES=(
    "workstation-base:v1"
    "workstation-profile:developer"
    "workstation-profile:data-analyst"
    "workstation-profile:devops"
  )
fi

mkdir -p "$REPORT_DIR"
trivy() {
  sudo docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v trivy-cache:/root/.cache/ \
    -v "$REPORT_DIR":/reports \
    "$TRIVY_IMAGE" "$@"
}

echo "=== Trivy scan ($TRIVY_IMAGE) → $REPORT_DIR ==="
printf '%-36s %9s %6s %8s %5s\n' "IMAGE" "CRITICAL" "HIGH" "MEDIUM" "LOW" | tee "$REPORT_DIR/summary.txt"

FAILED_GATE=0
for img in "${IMAGES[@]}"; do
  name="$(echo "$img" | tr ':/' '__')"
  # Πλήρες JSON report (όλες οι σοβαρότητες) = το τεκμήριο συμμόρφωσης
  trivy image --quiet --timeout 15m --format json --output "/reports/$name.json" "$img"
  # Αναγνώσιμος πίνακας μόνο με CRITICAL/HIGH
  trivy convert --quiet --format table --severity CRITICAL,HIGH --output "/reports/$name.txt" "/reports/$name.json"

  count() { grep -o "\"Severity\": \"$1\"" "$REPORT_DIR/$name.json" | wc -l || true; }
  crit="$(count CRITICAL)"; high="$(count HIGH)"; med="$(count MEDIUM)"; low="$(count LOW)"
  printf '%-36s %9s %6s %8s %5s\n' "$img" "$crit" "$high" "$med" "$low" | tee -a "$REPORT_DIR/summary.txt"
  if [ "$crit" -gt 0 ] || [ "$high" -gt 0 ]; then FAILED_GATE=1; fi
done

sudo chown -R "$(id -u):$(id -g)" "$REPORT_DIR"
echo "Reports: $REPORT_DIR (*.json = πλήρες report, *.txt = CRITICAL/HIGH, summary.txt = σύνοψη)"

if [ "$GATE" = "1" ] && [ "$FAILED_GATE" = "1" ]; then
  echo "[GATE] FAILED: βρέθηκαν CRITICAL/HIGH ευπάθειες (κριτήριο: 0 Critical / 0 High)"
  exit 1
fi
