# Compliance Engine

> Αυτόνομο εργαλείο ελέγχου συμμόρφωσης (compliance) και αυτόματης αποκατάστασης (auto-remediation) για workloads σε Kubernetes, με βάση το ISO/IEC 27001:2022 Annex A.8 και τα CIS Benchmarks.

**Κατάσταση (v0.1.0):** λειτουργεί το API (`/evaluate`) με τον πρώτο κανόνα, **A.8.9 Configuration management**, μαζί με την επανεξέταση του cluster (`/cluster/scan`: kube-bench + Pod Security Admission). Η πλατφόρμα της διπλωματικής το χρησιμοποιεί σε κάθε deploy.

---

## Τι είναι

Το Compliance Engine ελέγχει κάθε workload που πάει να σηκωθεί σε ένα Kubernetes cluster απέναντι σε ένα σύνολο κανόνων ασφαλείας. Ό,τι μπορεί να διορθωθεί το διορθώνει αυτόματα, ό,τι δεν μπορεί το απορρίπτει, και καταγράφει κάθε απόφαση ως αποδεικτικό στοιχείο (audit evidence) για έναν auditor.

Είναι **ξεχωριστό από την πλατφόρμα** που δημιουργεί τα workloads. Η πλατφόρμα της διπλωματικής (on-demand workstations) είναι ο πρώτος χρήστης του, αλλά το εργαλείο δεν εξαρτάται από αυτήν και μπορεί να χρησιμοποιηθεί από οποιοδήποτε σύστημα κάνει deploy σε Kubernetes.

## Γιατί ξεχωριστό εργαλείο

- **Μεταφέρσιμο:** το ίδιο εργαλείο λειτουργεί με οποιαδήποτε πλατφόρμα και σε οποιοδήποτε cluster (on-prem ή cloud).
- **Ανεξάρτητο από γλώσσα:** τρέχει ως υπηρεσία και επικοινωνεί μέσω HTTP.
- **Χωρίς εξαρτήσεις:** μόνο Node.js, καμία εξωτερική βιβλιοθήκη.
- **Μετρήσιμο:** μπορεί να τρέξει πάνω σε οποιοδήποτε manifest και να δώσει σύγκριση «πριν / μετά».
- **Διαχωρισμός καθηκόντων (ISO A.5.3):** οι κανόνες ασφαλείας και τα αποδεικτικά ανήκουν στο εργαλείο, όχι στην πλατφόρμα.

## Τρόποι χρήσης

```
                      ┌──────────── Compliance Engine ─────────────────────────────────────┐
Πλατφόρμα ───────────► POST /evaluate     έλεγχος + διόρθωση πριν από το deploy      ✅ v0.1
Πλατφόρμα ───────────► POST /cluster/scan επανεξέταση cluster (kube-bench + PSA)    ✅ v0.1
Οποιοσδήποτε (kubectl) ► Admission Webhook  έλεγχος ό,τι μπαίνει στο cluster          σχέδιο
CI/CD ───────────────► CLI                έλεγχος αρχείων YAML πριν από το merge     σχέδιο
Υπεύθυνος ασφαλείας ─► UI                 κανόνες ON/OFF, reports                    σχέδιο
                      └────────────────────────────────────────────────────────────────────┘
```

Μέχρι να υπάρξει το δικό του UI, οι διακόπτες ON/OFF των κανόνων βρίσκονται στην πλατφόρμα που το καλεί, και στέλνονται σε κάθε κλήση του `/evaluate`. Έτσι το εργαλείο δεν κρατά καμία ρύθμιση πλατφόρμας.

## Πώς αποφασίζει

Για κάθε κανόνα και κάθε έλεγχο (check) του κανόνα:

| Αποτέλεσμα ελέγχου | Σημασία |
|---|---|
| `PASS` | Η ρύθμιση είναι ήδη συμμορφούμενη |
| `REMEDIATED` | Διορθώθηκε αυτόματα στο manifest (φαίνεται η τιμή πριν και μετά) |
| `BLOCKED` | Δεν διορθώνεται χωρίς να χαλάσει το workload → **το deployment απορρίπτεται** (`DENY`) |
| `VIOLATION_NOT_ENFORCED` | Υπάρχει παράβαση, αλλά ο κανόνας είναι απενεργοποιημένος (εξαίρεση ορατή στον auditor) |

Ο έλεγχος τρέχει **και όταν ο κανόνας είναι OFF**: το manifest δεν αλλάζει, αλλά το report καταγράφει την παράβαση και ποιος απενεργοποίησε τον κανόνα και πότε.

## Κανόνες

Κάθε κανόνας είναι ανεξάρτητο module στο `src/rules/` που δηλώνει τον έλεγχο του ISO, την πηγή (CIS), τους ελέγχους του και πώς διορθώνεται ο καθένας. Νέος κανόνας = νέο αρχείο + μία γραμμή στο `src/rules/index.js`.

### Υλοποιημένοι

**A.8.9 Configuration management**: CIS Kubernetes Benchmark v1.8, §5.2

| CIS | Έλεγχος | Αν παραβιάζεται |
|---|---|---|
| 5.2.3 | `hostPID` | διόρθωση σε `false` |
| 5.2.4 | `hostIPC` | διόρθωση σε `false` |
| 5.2.5 | `hostNetwork` | διόρθωση σε `false` |
| 5.2.6 | `allowPrivilegeEscalation` (κάθε container και init container) | διόρθωση σε `false` |
| 5.2.12 | `hostPath` volumes | μπλοκάρισμα |
| 5.2.13 | `hostPort` | μπλοκάρισμα |

Επανεξέταση του cluster (το «reviewed» του A.8.9), `POST /cluster/scan`:

| Έλεγχος | Πώς |
|---|---|
| CIS Kubernetes Benchmark για το cluster (nodes, control plane, policies) | **kube-bench** (`aquasec/kube-bench:v0.15.6`), ως Job στο namespace `compliance-system`. Αναγνωρίζει μόνο του το k3s και διαλέγει το αντίστοιχο benchmark |
| Pod Security Admission στα namespaces των workloads (CIS 5.2.1, δεύτερη γραμμή άμυνας) | έλεγχος των labels `pod-security.kubernetes.io/*`: `enforce: baseline` ή `restricted` = συμμορφούμενο |

Κάθε scan αποθηκεύεται ως **cluster-logs** (με SHA-256), και το τελευταίο scan μπαίνει αυτούσιο στην ενότητα `cluster_review` κάθε report αξιολόγησης (workspace-logs). Το εργαλείο **δεν** αποφασίζει πότε τρέχει: η πλατφόρμα το καλεί (π.χ. καθημερινά, σε κάθε deploy, κατ' απαίτηση).

### Σχεδιασμένοι (Tiers 1–3, 22 έλεγχοι του Annex A.8)

| Τρόπος υλοποίησης | Έλεγχοι |
|---|---|
| Έλεγχος και διόρθωση manifest | A.8.28, A.8.31, A.8.12, A.8.6, A.8.2, A.8.16, A.8.29, A.8.24, A.8.21 |
| Εξωτερικά εργαλεία (Trivy, ClamAV, Cosign, kube-bench) | A.8.7, A.8.8, A.8.12 (secrets στο image), A.8.4, A.8.27, A.8.20, A.8.22, A.8.15 |
| Μέσω webhook (ποιος κάνει το αίτημα) | A.8.5, A.8.32, A.8.3 (μόνο report) |
| Ιδιότητες του ίδιου του εργαλείου | A.8.25 (shift-left έλεγχος), A.8.26 (δυναμικοί κανόνες) |

## Αποδεικτικά (evidence)

Τα αποδεικτικά ανήκουν στο εργαλείο και αποθηκεύονται στον φάκελο δεδομένων του (`DATA_DIR`, προεπιλογή `compliance-engine/data/`, εκτός git):

```
data/
├── reports/<report_id>.json        ένα πλήρες report ανά αξιολόγηση (workspace-logs)
├── cluster/<scan_id>.json          ένα πλήρες report ανά επανεξέταση του cluster (cluster-logs)
└── logs/decisions-YYYY-MM-DD.jsonl ημερήσιο log αποφάσεων (μία γραμμή ανά αξιολόγηση ή scan, μόνο προσθήκες)
```

Κάθε report περιέχει: ποιο workload ελέγχθηκε και για ποιον (context του καλούντος), έκδοση εργαλείου και κανόνων, όλους τους κανόνες (ON και OFF), κάθε έλεγχο με αναφορά ISO/CIS και τιμή πριν/μετά, την τελική απόφαση (`ALLOW`/`DENY`), SHA-256 του manifest πριν και μετά, το τελευταίο review του cluster (`cluster_review`) και τους κανόνες που ζητήθηκαν αλλά δεν υπάρχουν στο εργαλείο (`unknown_rules`). Το SHA-256 του ίδιου του report επιστρέφεται στον καλούντα και γράφεται στο log, ώστε κάθε αλλοίωση να εντοπίζεται. Παράδειγμα: [examples/sample-report.json](examples/sample-report.json).

## Τι δεν κάνει

Το εργαλείο **ελέγχει, διορθώνει όσα μπορεί και αποδεικνύει**. Δεν φτιάχνει και δεν στήνει:

- **Την ασφάλεια της πλατφόρμας** (login, ρόλοι, έγκριση αιτημάτων). Ευθύνη της πλατφόρμας.
- **Το hardening των images** (αφαίρεση sudo, pinning εκδόσεων, υπογραφή). Γίνεται στο build της πλατφόρμας· το εργαλείο ελέγχει το αποτέλεσμα (scans, υπογραφή).
- **Την υποδομή** (namespaces με τα labels του Pod Security Admission, audit logging του k3s, Ingress, TLS). Το εργαλείο ελέγχει ότι υπάρχουν και αναφέρει όσα λείπουν.

**Γνωστό ρίσκο:** για το kube-bench το εργαλείο χρησιμοποιεί το kubeconfig του μηχανήματος (πλήρη δικαιώματα στο cluster). Θα αντικατασταθεί από δικό του ServiceAccount με ελάχιστα δικαιώματα (κανόνας A.8.3).

Τι χρειάζεται να κάνει μια πλατφόρμα για να το χρησιμοποιήσει: [integration-instructions.md](integration-instructions.md).

## Δομή

```
compliance-engine/
├── src/
│   ├── server.js        HTTP API (/health, /rules, /evaluate, /reports/:id), API key
│   ├── engine.js        αξιολόγηση, διόρθωση, report (δεν αποθηκεύει τίποτα)
│   ├── store.js         αποθήκευση reports και log αποφάσεων
│   ├── workload.js      εντοπισμός του Pod spec (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob)
│   ├── cluster.js       επανεξέταση του cluster: kube-bench (Job) και Pod Security Admission, μέσω kubectl
│   ├── canonical.js     κανονικοποιημένο JSON και SHA-256
│   ├── config.js        ρυθμίσεις από .env
│   └── rules/           ένας κανόνας ανά αρχείο
├── test/                αυτόματα tests (npm test)
├── examples/            δείγμα report
└── .env.example
```

## Εκτέλεση

```bash
cp .env.example .env      # API_KEY: openssl rand -hex 32
npm start                 # http://127.0.0.1:5100
npm test                  # tests (node:test)
```

Στο VM της διπλωματικής το ξεκινά και το ενημερώνει το `deploy.sh` (pm2 process `compliance-engine`).
