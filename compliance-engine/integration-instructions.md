# Integration Guide

> Τι πρέπει να κάνει μια πλατφόρμα για να χρησιμοποιήσει το Compliance Engine.

**Κατάσταση:** τα API των ενοτήτων 3.1 και 3.2 είναι υλοποιημένα (v0.2.0). Ό,τι σημειώνεται ως *(σχέδιο)* δεν υπάρχει ακόμα.

---

## 1. Προαπαιτούμενα

- Node.js ≥ 20.19 στο μηχάνημα που τρέχει το εργαλείο (καμία άλλη εξάρτηση).
- Kubernetes cluster για τα workloads (δοκιμασμένο σε k3s).

## 2. Εγκατάσταση του εργαλείου

```bash
cd compliance-engine
cp .env.example .env            # HOST, PORT, API_KEY (≥ 32 χαρακτήρες: openssl rand -hex 32)
pm2 start src/server.js --name compliance-engine --cwd "$PWD"
curl http://127.0.0.1:5100/health
```

Το εργαλείο ακούει μόνο στο `127.0.0.1` από προεπιλογή: η πλατφόρμα το καλεί από το ίδιο μηχάνημα.

*(σχέδιο)* Container και εγκατάσταση στο cluster: `kubectl apply -f compliance-engine.yaml`, σε δικό του namespace (`compliance`).

## 3. Σύνδεση της πλατφόρμας

### 3.1 API: έλεγχος πριν από το deploy

Όλα τα endpoints εκτός από το `/health` απαιτούν `Authorization: Bearer <API_KEY>`.

| Μέθοδος | Endpoint | Περιγραφή |
|---|---|---|
| `GET` | `/health` | Κατάσταση, έκδοση, κανόνες (δημόσιο) |
| `GET` | `/rules` | Κατάλογος κανόνων με ISO, CIS και ελέγχους |
| `POST` | `/evaluate` | Αξιολόγηση και διόρθωση ενός manifest |
| `GET` | `/reports/:report_id` | Το αποθηκευμένο report, αυτούσιο |
| `POST` | `/cluster/scan` | Επανεξέταση του cluster: kube-bench + Pod Security Admission (ενότητα 3.2) |
| `GET` | `/cluster/latest` | Σύνοψη του τελευταίου scan |
| `GET` | `/cluster/reports/:scan_id` | Το αποθηκευμένο cluster-logs, αυτούσιο |

**Αίτημα `POST /evaluate`:**

```json
{
  "manifest": { "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "..." }, "spec": { "containers": [ ... ] } },
  "rules": [
    { "id": "A.8.9", "enabled": true, "changed_by": "admin@example.com", "changed_at": "2026-10-15T09:10:00Z" },
    { "id": "A.8.28", "enabled": true }
  ],
  "context": { "platform": "my-platform", "owner": "dev@example.com", "approved_by": "admin@example.com" }
}
```

- `manifest`: Pod ή workload με Pod template (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob).
- `rules`: ποιοι κανόνες είναι ενεργοί. Κανόνας που λείπει θεωρείται **απενεργοποιημένος**. Τα `changed_by` / `changed_at` (προαιρετικά) μπαίνουν στο report, ώστε να φαίνεται ποιος απενεργοποίησε έναν κανόνα.
- `context`: ελεύθερα στοιχεία της πλατφόρμας (ποιος, πότε, ποιο profile) που καταγράφονται αυτούσια στο report.

**Απάντηση:**

```json
{
  "report_id": "053926c4-b226-4b75-b274-553665d5cd4a",
  "report_sha256": "9f2c…",
  "decision": "ALLOW",
  "compliant": true,
  "summary": { "rules_enabled": ["A.8.9", "A.8.28"], "rules_disabled": [], "checks_total": 8, "passed": 6, "remediated": 2, "blocked": 0, "violations_not_enforced": 0 },
  "rules": [ { "rule": "A.8.9", "enabled": true, "outcome": "REMEDIATED" }, { "rule": "A.8.28", "enabled": true, "outcome": "REMEDIATED" } ],
  "unknown_rules": [],
  "manifest": { "...": "το διορθωμένο manifest, έτοιμο για deploy" }
}
```

Κανόνες για την πλατφόρμα:
- `compliant: false` (`decision: DENY`): **δεν** γίνεται deploy.
- Γίνεται deploy **το manifest της απάντησης**, όχι το αρχικό.
- Κρατήστε τα `report_id` και `report_sha256`. Όταν κατεβάζετε το report (`GET /reports/:id`), ελέγξτε ότι το SHA-256 των bytes ταιριάζει· αν όχι, το report έχει αλλοιωθεί.
- `outcome` ανά κανόνα: `COMPLIANT`, `REMEDIATED`, `BLOCKED`, `DISABLED_VIOLATIONS_FOUND`, `DISABLED_NO_VIOLATIONS`.
- `unknown_rules`: κανόνες που έστειλε η πλατφόρμα αλλά δεν υπάρχουν στο εργαλείο (π.χ. λάθος ID ή κανόνας νεότερης έκδοσης). Αγνοούνται στην αξιολόγηση· αν η λίστα δεν είναι κενή, η πλατφόρμα πρέπει να το ελέγξει, γιατί ένας κανόνας που θεωρεί ενεργό δεν εφαρμόζεται.

Κωδικοί σφάλματος: `400` λάθος αίτημα, `401` λάθος/χωρίς API key, `413` πολύ μεγάλο σώμα (> 1 MB), `422` μη υποστηριζόμενο είδος manifest.

Πλήρες δείγμα report: [examples/sample-report.json](examples/sample-report.json). Η ενότητα `cluster_review` του δείγματος περιέχει απόσπασμα του πρώτου πραγματικού review του cluster (3 από τα 130 αποτελέσματα του kube-bench).

### 3.2 Επανεξέταση του cluster (A.8.9 «reviewed»)

Το εργαλείο τρέχει το CIS Kubernetes Benchmark με το **kube-bench** (Job στο namespace `compliance-system`) και ελέγχει τα labels του **Pod Security Admission** στα namespaces των workloads (`CLUSTER_NAMESPACES`). Το **πότε** το αποφασίζει η πλατφόρμα.

**Αίτημα:**

```json
POST /cluster/scan
{ "trigger": "SCHEDULED", "requested_by": "admin@example.com" }
```

- `trigger`: `SCHEDULED` (αυτόματο), `STARTUP` (εκκίνηση/deploy) ή `MANUAL` (κατ' απαίτηση από χρήστη).
- `requested_by`: ποιος το ζήτησε (για τα `MANUAL`), μπαίνει στο report.
- Η κλήση περιμένει να τελειώσει το scan (έως `CLUSTER_SCAN_TIMEOUT_SECONDS`, προεπιλογή 300 δευτερόλεπτα· την πρώτη φορά κατεβαίνει και το image). Δύο scans δεν τρέχουν ταυτόχρονα (`409`).

**Απάντηση:**

```json
{
  "scan_id": "…", "report_sha256": "…", "status": "COMPLETED", "trigger": "SCHEDULED", "generated_at": "…",
  "summary": { "pass": 52, "fail": 2, "warn": 8, "info": 0, "psa_compliant": true }
}
```

- `status: FAILED` (π.χ. δεν κατέβηκε το image): αποθηκεύεται κανονικά report με το σφάλμα, ως αποδεικτικό ότι επιχειρήθηκε η επανεξέταση.
- Κρατήστε `scan_id` και `report_sha256` και ελέγξτε το SHA-256 κατά τη λήψη (`GET /cluster/reports/:scan_id`).
- Το τελευταίο scan μπαίνει αυτούσιο σε κάθε επόμενο report αξιολόγησης (`cluster_review`).

**Τι χρειάζεται το εργαλείο:** `kubectl` και kubeconfig (`KUBECONFIG`, προεπιλογή `~/.kube/config`) με δικαίωμα να δημιουργεί namespace και Jobs και να διαβάζει namespaces, και πρόσβαση στο Docker Hub για το image του kube-bench.

### 3.3 Admission webhook *(σχέδιο)*

Όταν είναι ενεργό, το εργαλείο ελέγχει ό,τι μπαίνει στο cluster, ακόμα κι αν η πλατφόρμα δεν το καλέσει. Δεν χρειάζεται αλλαγή στον κώδικα της πλατφόρμας, μόνο οι ρυθμίσεις της ενότητας 4.

## 4. Ευθύνες της πλατφόρμας

Όσα **δεν** κάνει το εργαλείο και πρέπει να φροντίσει η πλατφόρμα:

| Τι | Γιατί | Κανόνας |
|---|---|---|
| Διακόπτες ON/OFF των κανόνων και ποιος τους άλλαξε | Μέχρι να υπάρξει το UI του εργαλείου, στέλνονται σε κάθε `/evaluate` | όλοι |
| Namespace των workloads με labels του Pod Security Admission (`enforce: baseline` ή `restricted`) | Το εργαλείο ελέγχει τα labels, δεν φτιάχνει τα namespaces της πλατφόρμας | A.8.9 (CIS 5.2.1) |
| Κλήση του `POST /cluster/scan` τουλάχιστον μία φορά την ημέρα | Το εργαλείο δεν έχει δικό του χρονοπρογραμματισμό | A.8.9 (επανεξέταση) |
| Τα workloads να μην τρέχουν στο `default` namespace | Το webhook μπορεί μόνο να απορρίψει, όχι να αλλάξει namespace | A.8.31 |
| Ο ServiceAccount της πλατφόρμας να δηλωθεί στο εργαλείο ως εγκεκριμένος | Αλλιώς ο κανόνας GitOps θα μπλοκάρει την ίδια την πλατφόρμα | A.8.32 |
| Hardening των images στο build (non-root, χωρίς sudo, pinned εκδόσεις) | Το εργαλείο ελέγχει τα images, δεν τα ξαναχτίζει | A.8.28, A.8.2 |
| Τα images να δηλώνουν **αριθμητικό** χρήστη (`USER 1000`, όχι `USER coder`) | Ο A.8.28 βάζει `runAsNonRoot: true` και δεν ορίζει UID· με όνομα χρήστη το kubelet δεν ξεκινά το container | A.8.28 |
| Υπογραφή των images (Cosign) | Ο κανόνας απορρίπτει ανυπόγραφα images | A.8.4 |
| Ingress με TLS, αν εκτίθενται υπηρεσίες | Το εργαλείο ελέγχει τη ρύθμιση, δεν εγκαθιστά certificates | A.8.24, A.8.21 |
| Backup του `compliance-engine/data/` (reports, cluster-logs, logs αποφάσεων) | Είναι τα αποδεικτικά· το εργαλείο τα γράφει, δεν κρατά αντίγραφα | A.8.13, A.8.15 |
| Ενεργό audit logging στο cluster | Το εργαλείο το ελέγχει, δεν αλλάζει τις ρυθμίσεις του k3s | A.8.15 |

## 5. Αν το εργαλείο δεν είναι διαθέσιμο

**Fail-closed:** αν το εργαλείο δεν απαντά, απαντά με σφάλμα ή το API key είναι λάθος, το deploy **δεν** γίνεται. Ένα workload που δεν ελέγχθηκε δεν παραδίδεται στον χρήστη.

## 6. Παράδειγμα: η πλατφόρμα της διπλωματικής (`manager/`)

Υλοποιημένες αλλαγές (v0.1.0, v0.2.0):

- [x] `manager/.env`: `COMPLIANCE_ENGINE_URL` και `COMPLIANCE_ENGINE_API_KEY` (τα συμπληρώνει αυτόματα το `deploy.sh`, που δημιουργεί και το `compliance-engine/.env` με τυχαίο key την πρώτη φορά).
- [x] `manager/compliance.js`: client του εργαλείου (timeout, fail-closed, έλεγχος SHA-256 στη λήψη report).
- [x] Stage 2 του pipeline (`manager/workstations.js`): οι κανόνες του profile στέλνονται στο `/evaluate`, γίνεται deploy το διορθωμένο manifest, και σε `DENY` δεν δημιουργείται τίποτα στο k3s.
- [x] Migration `database/migrations/002_compliance_engine.sql`: ο κανόνας A.8.9 στο Policy Checklist ανά profile (προεπιλογή ON), `policy_rules.updated_by`, πίνακας `compliance_reports` (μόνο ID, SHA-256, απόφαση).
- [x] Migration `database/migrations/004_a828_secure_coding.sql` (v0.2.0): ο κανόνας A.8.28 στο Policy Checklist ανά profile (προεπιλογή ON). Καμία αλλαγή στον κώδικα του `manager/`· τα images ήδη τελειώνουν σε `USER 1000`.
- [x] Audit της πλατφόρμας: μία εγγραφή `COMPLIANCE` ανά κανόνα, `COMPLIANCE-GATE` σε απόρριψη, `COMPLIANCE-ENGINE` όταν το εργαλείο δεν απαντά, `REPORT-DOWNLOAD` σε κάθε λήψη.
- [x] UI: κουμπί «📄 workspace-logs» μόνο για τον admin, στην καρτέλα Workstations και στο Audit Trail (γραμμή `DEPLOY` ή `COMPLIANCE-GATE`), ώστε το report να κατεβαίνει και μετά τον τερματισμό → `GET /api/workstations/:id/compliance-report`. Ο developer δεν βλέπει το report.
- [x] Policy Checklist με ένα υπο-tab ανά profile.
- [x] Namespace `workstations` με Pod Security Admission (`deploy/k8s/workstations-namespace.yaml`, `enforce: baseline`, `warn`/`audit: restricted`), το εφαρμόζει το `deploy.sh`, που μεταφέρει και τα workstations από το `default`.
- [x] Επανεξέταση του cluster (`manager/cluster-scans.js`, migration `003_cluster_scans.sql`): σε κάθε εκκίνηση του Manager, κάθε 24 ώρες (`CLUSTER_SCAN_INTERVAL_HOURS`) και με το κουμπί «▶ Έλεγχος cluster (CIS) τώρα» στο Policy Checklist. Κάθε scan γράφει γραμμή `CLUSTER / CIS-SCAN` στο Audit Trail με κουμπί «📄 cluster-logs».
- [ ] Αφαίρεση της καρτέλας «Policies» από το `/admin`, όταν υπάρξει το UI του εργαλείου.
- [ ] Έλεγχος από τον κανόνα A.8.31 ότι κανένα workload δεν τρέχει στο `default` (το namespace υπάρχει ήδη).
- [ ] Δήλωση του ServiceAccount του Manager ως εγκεκριμένου (A.8.32).
