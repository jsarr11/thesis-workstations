#!/bin/bash
# Ημερήσιο backup της PostgreSQL + export των audit logs της προηγούμενης ημέρας.
# Εκτελείται ως root από το cron (δες database/thesis-db-backup.cron). Χειροκίνητα: sudo bash database/backup.sh
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/thesis-db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CONTAINER="thesis-postgres"
MANAGER_URL="${MANAGER_URL:-http://localhost:5000}"
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"

# Ίδιες τιμές με το docker-compose.yml (database/.env), με τις ίδιες προεπιλογές
POSTGRES_USER="thesis_admin"
POSTGRES_DB="thesis_workstations_db"
if [ -f "$ENV_FILE" ]; then
  POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]' || true)"
  POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]' || true)"
  POSTGRES_USER="${POSTGRES_USER:-thesis_admin}"
  POSTGRES_DB="${POSTGRES_DB:-thesis_workstations_db}"
fi

STAMP="$(date +%F_%H%M)"
YESTERDAY="$(TZ=Europe/Athens date -d yesterday +%F)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "[$(date -Is)] Backup started"

# 1. Πλήρες dump της βάσης (μέσα από το container — η τοπική σύνδεση στο container δεν θέλει κωδικό)
DUMP="$BACKUP_DIR/thesis-db_$STAMP.sql.gz"
docker exec "$CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner | gzip > "$DUMP.tmp"
mv "$DUMP.tmp" "$DUMP"
echo "[+] Database dump: $DUMP ($(du -h "$DUMP" | cut -f1))"

# 2. Audit logs της προηγούμενης ημέρας (compliance evidence) μέσω του Manager
AUDIT="$BACKUP_DIR/audit-logs-$YESTERDAY.json"
if curl -fsS "$MANAGER_URL/api/audit-logs/export?date=$YESTERDAY&format=json" -o "$AUDIT.tmp"; then
  mv "$AUDIT.tmp" "$AUDIT"
  echo "[+] Audit logs: $AUDIT"
else
  rm -f "$AUDIT.tmp"
  echo "[!] Ο Manager δεν απάντησε — παραλείπεται το export των audit logs"
fi

# 3. Διαγραφή backups παλαιότερων από RETENTION_DAYS ημέρες
find "$BACKUP_DIR" -type f \( -name 'thesis-db_*.sql.gz' -o -name 'audit-logs-*.json' \) -mtime +"$RETENTION_DAYS" -delete

echo "[$(date -Is)] Backup completed"
