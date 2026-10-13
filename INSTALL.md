# Οδηγός Εγκατάστασης (από το μηδέν, σε δικό σου Proxmox)

Ο οδηγός αυτός περιγράφει **όλα** τα βήματα για να στήσεις το σύστημα σε δικό σου περιβάλλον: GitHub, Proxmox, VM, cluster, βάση, images, Manager, CI/CD και backups. Για το τι κάνει το σύστημα, δες το [README](README.md).

> ⏱️ Συνολικός χρόνος: περίπου 1,5–2 ώρες. Τον περισσότερο χρόνο τον παίρνουν η εγκατάσταση του Ubuntu και το πρώτο build των images.

---

## Περιεχόμενα

0. [Τι θα στήσεις](#0-τι-θα-στήσεις)
1. [Απαιτήσεις](#1-απαιτήσεις)
2. [GitHub: το δικό σου αντίγραφο του repository](#2-github-το-δικό-σου-αντίγραφο-του-repository)
3. [Proxmox: δημιουργία του VM](#3-proxmox-δημιουργία-του-vm)
4. [Ubuntu Server: εγκατάσταση](#4-ubuntu-server-εγκατάσταση)
5. [VM: βασικά πακέτα, Docker, k3s, Node.js, PM2](#5-vm-βασικά-πακέτα-docker-k3s-nodejs-pm2)
6. [VM: κώδικας και ρυθμίσεις (.env)](#6-vm-κώδικας-και-ρυθμίσεις-env)
7. [VM: βάση δεδομένων](#7-vm-βάση-δεδομένων-postgresql)
8. [VM: δικαιώματα για το deploy](#8-vm-δικαιώματα-για-το-deploy-sudoers)
9. [VM: πρώτο deploy (images + Manager)](#9-vm-πρώτο-deploy-images--manager)
10. [GitHub Actions: self-hosted runner (CI/CD)](#10-github-actions-self-hosted-runner-cicd)
11. [Backups (cron)](#11-backups-cron)
12. [Τελικός έλεγχος](#12-τελικός-έλεγχος-από-άκρη-σε-άκρη)
13. [Καθημερινή χρήση](#13-καθημερινή-χρήση)
14. [Αντιμετώπιση προβλημάτων](#14-αντιμετώπιση-προβλημάτων)
15. [Ασφάλεια](#15-ασφάλεια)

---

## 0. Τι θα στήσεις

```
Το PC σου (browser) ──► VM στο Proxmox (Ubuntu 22.04)
                          ├── Manager (Node.js, PM2)      :5000   ← portal + admin + API
                          ├── PostgreSQL (Docker)         :5432
                          ├── k3s (Kubernetes)
                          │     └── Workstation Pods (VS Code στον browser)  :30000–32767
                          └── GitHub Actions runner       ← κάθε push στο main γίνεται deploy αυτόματα
```

Ό,τι τρέχει, τρέχει **μέσα σε ένα VM**. Στο PC σου χρειάζεσαι μόνο browser, τερματικό για SSH και git.

---

## 1. Απαιτήσεις

| Τι | Ελάχιστο | Προτεινόμενο | Γιατί |
|---|---|---|---|
| vCPU | 2 | **4** | build των images + workstations |
| RAM | 4 GB | **8 GB** | κάθε workstation χρειάζεται 0,5–4 GB |
| Δίσκος | 32 GB | **50 GB** | κάθε image υπάρχει **δύο φορές** (Docker + k3s), συνολικά περίπου 12–15 GB |
| Δίκτυο | IP στο LAN | σταθερή IP | τα URLs των workstations περιέχουν την IP |

Χρειάζεσαι επίσης:
- Proxmox VE με πρόσβαση στο web UI (`https://<proxmox-ip>:8006`)
- λογαριασμό στο GitHub
- στο PC σου: `git` και ένα τερματικό με `ssh` (στα Windows: PowerShell ή Git Bash)

> ⚠️ **Ο δίσκος είναι το πιο συχνό πρόβλημα.** Όταν ο δίσκος περάσει περίπου το 85%, το k3s σβήνει μόνο του τα images των workstations και τα Pods αποτυγχάνουν με `ErrImageNeverPull`. Δες το [§4](#4-ubuntu-server-εγκατάσταση) για το πώς αποφεύγεται.

---

## 2. GitHub: το δικό σου αντίγραφο του repository

Το CI/CD τρέχει σε **κάθε push στο `main` του δικού σου repository** και κάνει deploy στο **δικό σου** VM. Γι' αυτό χρειάζεσαι δικό σου αντίγραφο.

### Επιλογή Α: Fork (το πιο απλό, το αντίγραφο είναι public)
1. Άνοιξε το αρχικό repository και πάτα **Fork** (πάνω δεξιά) → **Create fork**.
2. Στο fork σου, πήγαινε στην καρτέλα **Actions** και πάτα **"I understand my workflows, go ahead and enable them"**. Στα forks τα Actions είναι απενεργοποιημένα από προεπιλογή.

### Επιλογή Β: Private αντίγραφο (προτείνεται)
Ένα fork ενός public repository δεν μπορεί να γίνει private. Για private αντίγραφο:
1. Πήγαινε στο **https://github.com/new/import**.
2. Στο "old repository URL" βάλε το URL του αρχικού repository, όρισε όνομα `thesis-workstations` και επίλεξε **Private** → **Begin import**.

### Ρυθμίσεις ασφαλείας (και για τις δύο επιλογές)
Ο self-hosted runner εκτελεί κώδικα **μέσα στο VM σου**. Το workflow (`.github/workflows/deploy.yml`) τρέχει **μόνο** σε push στο `main` και σε χειροκίνητη εκτέλεση, **όχι** σε pull requests, οπότε κάποιος τρίτος δεν μπορεί να εκτελέσει κώδικα στο VM σου ανοίγοντας ένα PR. Μην προσθέσεις trigger `pull_request` σε αυτό το workflow.

Αν το repository σου είναι public, πήγαινε επιπλέον: **Settings → Actions → General → "Fork pull request workflows from outside collaborators"** και επίλεξε **"Require approval for all outside collaborators"**.

---

## 3. Proxmox: δημιουργία του VM

### 3.1 Κατέβασμα του ISO στο Proxmox
**Datacenter → <node> → local (storage) → ISO Images → Download from URL**:
```
https://releases.ubuntu.com/22.04/ubuntu-22.04.5-live-server-amd64.iso
```
Πάτα **Query URL** και μετά **Download**.

### 3.2 Create VM (κουμπί πάνω δεξιά)

| Καρτέλα | Ρύθμιση |
|---|---|
| General | Name: `k3s-master` |
| OS | ISO image: `ubuntu-22.04.5-live-server-amd64.iso` |
| System | προεπιλογές (προαιρετικά ✔ Qemu Agent) |
| Disks | Bus: VirtIO Block / SCSI, **Disk size: 50 GB** |
| CPU | Cores: **4**, Type: `host` |
| Memory | **8192 MB** |
| Network | Bridge: `vmbr0`, Model: VirtIO |

**Finish** → επίλεξε το VM → **Start** → **Console**.

---

## 4. Ubuntu Server: εγκατάσταση

Στην κονσόλα του Proxmox:

1. Language / Keyboard: **English / English (US)**.
2. Type of install: **Ubuntu Server**.
3. Network: άφησε **DHCP**. Σημείωσε την IP που παίρνει (π.χ. `192.168.1.50`).
4. Storage: **Use an entire disk** + ✔ **Set up this disk as an LVM group**.
5. ⚠️ **Storage configuration: σημαντικό βήμα.** Ο installer δίνει στο `ubuntu-lv` μόνο **περίπου τον μισό** δίσκο. Στη λίστα, επίλεξε το `ubuntu-lv` → **Edit** → στο **Size** βάλε το **μέγιστο** (γράφει "max") → **Save**. Η γραμμή "free space" πρέπει να γίνει περίπου 0.
6. Profile: όνομα, όνομα server (`k3s-master`), **username** (π.χ. `root1`) και κωδικός.
7. SSH: ✔ **Install OpenSSH server**.
8. Featured snaps: **κανένα** (μην επιλέξεις το docker από εδώ).
9. Όταν τελειώσει: **Reboot Now**. Αν σου ζητήσει, αφαίρεσε το ISO από **Hardware → CD/DVD → Do not use any media**.

### 4.1 Σύνδεση με SSH από το PC σου
Από εδώ και πέρα δούλευε από το τερματικό του PC σου. Έτσι κάνεις copy-paste εύκολα.
```bash
ssh <username>@<ip-του-vm>
```

### 4.2 Αν ξέχασες το βήμα 5 (ο δίσκος δείχνει μισός)
```bash
df -h /            # αν το Size είναι περίπου μισό από τον δίσκο του VM...
sudo vgs           # ...και το VFree δείχνει ελεύθερο χώρο:
sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
df -h /            # τώρα πρέπει να δείχνει όλο τον δίσκο
```
Γίνεται χωρίς reboot και χωρίς απώλεια δεδομένων.

### 4.3 Σταθερή IP (προτείνεται)
Ο απλούστερος τρόπος είναι **DHCP reservation στο router**:
```bash
ip -br link        # βρες τη MAC address της κάρτας (π.χ. ens18)
```
Στη σελίδα διαχείρισης του router, κάνε reservation της τρέχουσας IP για αυτή τη MAC. Ο ακριβής τρόπος διαφέρει ανά router.

---

## 5. VM: βασικά πακέτα, Docker, k3s, Node.js, PM2

Όλες οι εντολές από εδώ και πέρα εκτελούνται **στο VM**, μέσω SSH.

### 5.1 Ενημέρωση και βασικά εργαλεία
```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y git curl ca-certificates
```

### 5.2 Docker και Docker Compose
```bash
sudo apt-get install -y docker.io docker-compose
sudo systemctl enable --now docker
sudo docker run --rm hello-world        # έλεγχος: πρέπει να τυπώσει "Hello from Docker!"
```

### 5.3 k3s (Kubernetes)
```bash
curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes                  # περίμενε μέχρι STATUS = Ready
```

Πρόσβαση στο cluster **χωρίς sudo**. Τη χρειάζονται και ο Manager και το `kubectl`:
```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
source ~/.bashrc
kubectl get nodes                       # χωρίς sudo, πρέπει να δείχνει Ready
```

### 5.4 Node.js 20 LTS (από το NodeSource)
> ⚠️ **Μην** εγκαταστήσεις τα `nodejs` και `npm` από τα repositories του Ubuntu, γιατί είναι πολύ παλιά (v12) και συγκρούονται με το NodeSource. Χρειάζεται **Node.js ≥ 20.19**.
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v                                 # π.χ. v20.20.x  (πρέπει ≥ v20.19)
```

### 5.5 PM2 (κρατά τον Manager σε λειτουργία)
```bash
sudo npm install -g pm2
pm2 -v
```

---

## 6. VM: κώδικας και ρυθμίσεις (.env)

### 6.1 Clone του repository
> ⚠️ Ο φάκελος **πρέπει** να είναι `~/thesis-workstations`, γιατί αυτή τη διαδρομή χρησιμοποιούν το `deploy.yml` και το `deploy.sh`.

**Public repository:**
```bash
git clone https://github.com/<το-github-σου>/thesis-workstations.git ~/thesis-workstations
```

**Private repository:** χρειάζεσαι ένα read-only **deploy key**:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/thesis_deploy -N "" -C "k3s-master deploy key"
cat ~/.ssh/thesis_deploy.pub            # αντέγραψε το περιεχόμενο
```
Στο GitHub: **repository → Settings → Deploy keys → Add deploy key**. Επικόλλησε το κλειδί, **μην** επιλέξεις "Allow write access" → **Add key**. Μετά:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/thesis_deploy
  IdentitiesOnly yes
EOF
git clone git@github.com:<το-github-σου>/thesis-workstations.git ~/thesis-workstations
```

### 6.2 Κωδικός βάσης
Φτιάξε έναν τυχαίο κωδικό και **κράτα τον**. Θα μπει σε δύο αρχεία:
```bash
openssl rand -base64 24 | tr -d '/+='
```

### 6.3 `database/.env`
```bash
cd ~/thesis-workstations
cp database/.env.example database/.env
nano database/.env
```
```ini
POSTGRES_USER=thesis_admin
POSTGRES_PASSWORD=<ο-κωδικός-του-6.2>
POSTGRES_DB=thesis_workstations_db
```

### 6.4 `manager/.env`
```bash
cp manager/.env.example manager/.env
nano manager/.env
```
```ini
PORT=5000
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=thesis_admin
DB_PASSWORD=<ο-ίδιος-κωδικός-του-6.2>
DB_NAME=thesis_workstations_db
K8S_NAMESPACE=default

# Προαιρετικά:
# PUBLIC_HOST=<ip-του-vm>       # αν λείπει, χρησιμοποιείται η διεύθυνση με την οποία άνοιξες το portal
# SESSION_TTL_HOURS=10          # μέγιστη διάρκεια ζωής ενός workstation
# REPORT_TIMEZONE=Europe/Athens # ζώνη ώρας για το ημερήσιο export των logs
```
Σε `nano`: αποθήκευση με **Ctrl+O** και Enter, έξοδος με **Ctrl+X**.

```bash
chmod 600 database/.env manager/.env    # μόνο ο χρήστης σου μπορεί να τα διαβάσει
```

> Τα αρχεία `.env` **δεν** μπαίνουν στο git (`.gitignore`), οπότε υπάρχουν μόνο στο VM. Κράτα τους κωδικούς και κάπου ασφαλές.

---

## 7. VM: βάση δεδομένων (PostgreSQL)

```bash
cd ~/thesis-workstations/database
sudo docker-compose up -d
sudo docker ps | grep thesis-postgres                 # πρέπει: Up
```
Έλεγχος ότι δημιουργήθηκαν οι πίνακες και τα 3 profiles:
```bash
sudo docker exec -it thesis-postgres psql -U thesis_admin -d thesis_workstations_db -c "SELECT id, name, image_tag FROM profiles;"
```
Πρέπει να δεις τρεις γραμμές: `developer`, `data-analyst`, `devops`.

> Το `init.sql` εκτελείται **μόνο** την πρώτη φορά που δημιουργείται το volume `pgdata`. Το container ξαναξεκινά μόνο του σε κάθε reboot (`restart: always`).

---

## 8. VM: δικαιώματα για το deploy (sudoers)

Το `deploy.sh` χρειάζεται `docker` και `k3s` χωρίς κωδικό, για να χτίζει και να εισάγει images. Ο κανόνας του repository επιτρέπει **μόνο** αυτές τις δύο εντολές. Το αρχείο αναφέρεται στον χρήστη `root1`, οπότε η παρακάτω εντολή βάζει αυτόματα **το δικό σου** όνομα χρήστη:
```bash
cd ~/thesis-workstations
sed "s/^root1 /$USER /" deploy/runner-sudoers > /tmp/runner-sudoers
sudo visudo -c -f /tmp/runner-sudoers
```
Μόνο αν δεις **`parsed OK`**:
```bash
sudo install -m 0440 /tmp/runner-sudoers /etc/sudoers.d/github-runner
```
Έλεγχος:
```bash
sudo -k; sudo -n docker info >/dev/null && echo "runner sudo OK"
```

> Αν το `command -v docker` **δεν** δείχνει `/usr/bin/docker` ή το `command -v k3s` **δεν** δείχνει `/usr/local/bin/k3s`, διόρθωσε τις διαδρομές στο `/tmp/runner-sudoers` πριν το `install`.

---

## 9. VM: πρώτο deploy (images + Manager)

Το ίδιο script που τρέχει το CI/CD κάνει και την πρώτη εγκατάσταση:
```bash
cd ~/thesis-workstations
bash deploy.sh
```
Τι κάνει, με τη σειρά:
1. `git pull` και `npm ci`, δηλαδή εγκατάσταση των βιβλιοθηκών του Manager
2. ξεκινά τον Manager με PM2 (`manager`)
3. **χτίζει** τα 4 images (base, developer, data-analyst, devops). Αυτό διαρκεί **15–30 λεπτά** την πρώτη φορά.
4. τα **εισάγει** στο k3s
5. ελέγχει ότι ο Manager απαντά (health check)

Στο τέλος πρέπει να δεις:
```
[+] Manager health check OK (port 5000)
=== [CD] Deployment Completed Successfully! ===
```

### 9.1 Αυτόματη εκκίνηση του Manager μετά από reboot
```bash
pm2 save
pm2 startup
```
Το `pm2 startup` τυπώνει μια εντολή που ξεκινά με `sudo env PATH=...`. **Αντέγραψέ την και τρέξ' την.** Έλεγχος:
```bash
systemctl is-enabled pm2-$USER          # πρέπει: enabled
```

### 9.2 Έλεγχος
```bash
pm2 status                                                 # manager: online
curl -s http://localhost:5000/api/health                   # {"status":"UP",...}
sudo k3s ctr -n k8s.io images ls -q | grep workstation     # 3 images
df -h /                                                    # κάτω από 80%
```

### 9.3 Πρώτος λογαριασμός admin
Η πρόσβαση στο σύστημα γίνεται μόνο με λογαριασμό. Τον **πρώτο admin** τον δημιουργείς από τη γραμμή εντολών. Όλους τους υπόλοιπους χρήστες τους δημιουργεί μετά ο admin από το UI.
```bash
cd ~/thesis-workstations/manager
node scripts/create-admin.js --email <το-email-σου> --name "<Ονοματεπώνυμο>" --username <username>
```
Το `username` γράφεται με πεζά λατινικά, αριθμούς και `-`, π.χ. `admin`. Το script τυπώνει έναν **προσωρινό κωδικό** μία φορά. Με αυτόν συνδέεσαι στο `http://<ip-του-vm>:5000/login` και αμέσως σου ζητείται να ορίσεις δικό σου κωδικό, τουλάχιστον 10 χαρακτήρων με γράμματα και αριθμούς.

> Αν ξεχάσεις τον κωδικό του admin: `node scripts/create-admin.js --email <το-email-σου> --reset`. Βγάζει νέο προσωρινό κωδικό.

---

## 10. GitHub Actions: self-hosted runner (CI/CD)

Ο runner είναι ένα πρόγραμμα **μέσα στο VM** που συνδέεται στο GitHub και περιμένει. Σε κάθε push στο `main`, το GitHub του στέλνει το job και αυτός τρέχει το `deploy.sh` τοπικά. Έτσι το GitHub δεν χρειάζεται πρόσβαση στο δίκτυό σου.

### 10.1 Εγγραφή του runner
1. Στο GitHub: **repository → Settings → Actions → Runners → New self-hosted runner**.
2. Διάλεξε **Linux** και **x64**.
3. Στο VM, τρέξε **μία-μία** τις εντολές της ενότητας **Download** όπως τις δείχνει η σελίδα (`mkdir actions-runner && cd actions-runner`, `curl ...`, `tar xzf ...`). Η έκδοση αλλάζει, γι' αυτό πάρε τις εντολές από τη σελίδα.
4. Από την ενότητα **Configure**, τρέξε την εντολή `./config.sh --url ... --token ...`. Το token **λήγει σε 1 ώρα**. Στις ερωτήσεις πάτα Enter για τις προεπιλογές. Το όνομα μπορεί να είναι `k3s-master`.
5. Εγκατάσταση ως service, ώστε να τρέχει πάντα και μετά από reboot:
   ```bash
   cd ~/actions-runner
   sudo ./svc.sh install
   sudo ./svc.sh start
   sudo ./svc.sh status | head -5          # active (running)
   ```
6. Στο GitHub → Settings → Actions → Runners, ο runner πρέπει να φαίνεται **Idle** (πράσινο).

### 10.2 Δοκιμή του pipeline
**Actions → Deploy to Proxmox VM → Run workflow → Run workflow.** Σε λίγα δευτερόλεπτα το job πρέπει να γίνει 🟢. Άνοιξέ το και δες το log του `deploy.sh`.

Από εδώ και πέρα, **κάθε `git push` στο `main` κάνει αυτόματα deploy στο VM**.

> ℹ️ Αν ο runner μείνει offline για αρκετές μέρες (π.χ. σβηστό VM), το GitHub τον **διαγράφει** αυτόματα και τα jobs μένουν **Queued**. Δες το [§14](#14-αντιμετώπιση-προβλημάτων).

---

## 11. Backups (cron)

Κάθε βράδυ στις 02:00 (ώρα του VM):
- dump της βάσης στο `/var/backups/thesis-db/`
- export των audit logs της προηγούμενης ημέρας σε JSON
- τα αρχεία κρατιούνται για 14 ημέρες

Το αρχείο του cron αναφέρεται στο `/home/root1`. Η παρακάτω εντολή βάζει αυτόματα **το δικό σου** home:
```bash
cd ~/thesis-workstations
sed "s#/home/root1#$HOME#" database/thesis-db-backup.cron | sudo tee /etc/cron.d/thesis-db-backup >/dev/null
cat /etc/cron.d/thesis-db-backup                           # έλεγχος της διαδρομής
sudo bash database/backup.sh                               # μία δοκιμή τώρα
sudo ls -lh /var/backups/thesis-db
```
Την επόμενη μέρα, έλεγξε ότι έτρεξε μόνο του:
```bash
cat /var/log/thesis-db-backup.log
```

**Επαναφορά** ενός backup (σε άδεια βάση):
```bash
gunzip -c /var/backups/thesis-db/thesis-db_<ημερομηνία>.sql.gz | sudo docker exec -i thesis-postgres psql -U thesis_admin -d thesis_workstations_db
```

---

## 12. Τελικός έλεγχος (από άκρη σε άκρη)

Από τον browser **του PC σου**:

1. **Login ως admin:** `http://<ip-του-vm>:5000/login`, με τον λογαριασμό του [§9.3](#93-πρώτος-λογαριασμός-admin).
2. **Δημιουργία developer:** `/admin` → καρτέλα **👥 Users** → συμπλήρωσε email, ονοματεπώνυμο, username και ρόλο `developer` → **Δημιουργία χρήστη**. Σημείωσε τον **προσωρινό κωδικό**, γιατί εμφανίζεται μόνο μία φορά.
3. **Αίτημα ως developer:** σε άλλο browser ή σε παράθυρο ανώνυμης περιήγησης, κάνε login με τον developer και όρισε νέο κωδικό. Στο portal διάλεξε **Software Developer** → **Αίτημα Workstation**. Στη λίστα «Τα workstations μου» πρέπει να εμφανιστεί **⏳ Αναμονή έγκρισης**.
4. **Έγκριση ως admin:** η καρτέλα **🔔 Notifications** γίνεται **κόκκινη** μέσα σε περίπου 10 δευτερόλεπτα. Πάτα **✔ Accept**.
5. **Στον developer:** η κατάσταση γίνεται 🚀 και μετά ✅ **Έτοιμο**. Πάτα **🔗 Άνοιγμα VS Code**. Πρέπει να ανοίξει το **VS Code** στον browser.
6. **Έλεγχος του token:** σε **νέο παράθυρο ανώνυμης περιήγησης**, άνοιξε το ίδιο URL **χωρίς** το κομμάτι `&tkn=...`. Ο VS Code **δεν** πρέπει να ανοίξει. Σε κανονικό παράθυρο θα άνοιγε, επειδή ο VS Code κρατά το token σε cookie μετά την πρώτη επίσκεψη.
7. **Έλεγχος ρόλων:** ως developer, άνοιξε το `/admin`. Πρέπει να σε γυρίσει στο portal.
8. **Reject:** κάνε ένα δεύτερο αίτημα και πάτα **✖ Reject** με αιτιολογία. Ο developer πρέπει να δει **❌ Απορρίφθηκε** μαζί με την αιτιολογία.
9. **Τερματισμός και audit:** πάτα **Τερματισμός** στο workstation. Στο `/admin` → **📜 Audit Trail** → **Export JSON** πρέπει να κατέβει αρχείο με όλα τα παραπάνω: login, αίτημα, έγκριση, απόρριψη, τερματισμός, μαζί με το ποιος έκανε την κάθε ενέργεια.
10. Επανάλαβε τα βήματα 3–5 με **Data Analyst** και **DevOps**.

Στο VM μπορείς να παρακολουθείς:
```bash
kubectl get pods,svc            # τα workstation Pods
pm2 logs manager                # τα logs του Manager ([LOG] Step 1..5); Ctrl+C για έξοδο
```

✅ Αν όλα αυτά δουλεύουν, η εγκατάσταση ολοκληρώθηκε.

---

## 13. Καθημερινή χρήση

| Θέλω να... | Εντολή / ενέργεια |
|---|---|
| ανεβάσω αλλαγές κώδικα | `git push` στο `main` από το PC σου, και το deploy γίνεται αυτόματα |
| κάνω deploy χωρίς push | GitHub → Actions → Deploy to Proxmox VM → **Run workflow** |
| δω τα logs του Manager | `pm2 logs manager` |
| κάνω restart τον Manager | `pm2 restart manager` |
| δω τα workstations | `kubectl get pods,svc` |
| σβήσω ένα workstation | `/admin` → **Terminate** (ή ο ίδιος ο χρήστης από το portal) |
| εγκρίνω/απορρίψω αιτήματα | `/admin` → **🔔 Notifications** (κόκκινη καρτέλα όταν υπάρχουν αιτήματα) |
| προσθέσω χρήστη / reset κωδικού | `/admin` → **👥 Users** |
| ξεκλειδώσω τον admin (ξεχασμένος κωδικός) | `cd ~/thesis-workstations/manager && node scripts/create-admin.js --email <email> --reset` |
| αλλάξω τη διάρκεια των sessions | `SESSION_TTL_HOURS` στο `manager/.env` → `pm2 restart manager` |
| ξαναχτίσω ένα image | `sudo docker rmi workstation-profile:<profile>` → `bash deploy.sh` (το ξαναχτίζει μόνο του) |
| βγάλω vulnerability report | `bash docker/scan-images.sh` → `reports/<ημερομηνία>/` |
| δω τον ελεύθερο χώρο | `df -h /` (κράτα τον κάτω από 80%) |

---

## 14. Αντιμετώπιση προβλημάτων

| Σύμπτωμα | Πιθανή αιτία | Λύση |
|---|---|---|
| Το portal βγάζει «This site can't be reached» | το VM είναι σβηστό, άλλαξε η IP του, ή ο Manager δεν τρέχει | Proxmox → Start. `ip -br addr` για την IP. `pm2 status`, και αν η λίστα είναι άδεια `pm2 resurrect` |
| `No space left on device` | γέμισε ο δίσκος | [§4.2](#42-αν-ξέχασες-το-βήμα-5-ο-δίσκος-δείχνει-μισός), `sudo docker builder prune -af`, `sudo journalctl --vacuum-size=100M` |
| Το Pod μένει σε `ErrImageNeverPull` | το k3s έσβησε τα images (δίσκος > 85%) | ελευθέρωσε χώρο και τρέξε `bash deploy.sh` (τα ξαναχτίζει και τα εισάγει) |
| Το portal δείχνει «Η δημιουργία απέτυχε: …» | το μήνυμα λέει την αιτία | `pm2 logs manager` και `kubectl describe pod <όνομα>` |
| Τα jobs στο GitHub μένουν **Queued** | ο runner είναι offline ή **διαγράφηκε** («There are no runners configured») | στο VM: `cd ~/actions-runner && sudo ./svc.sh status`. Αν διαγράφηκε: `sudo ./svc.sh stop; sudo ./svc.sh uninstall; rm -f .runner .credentials .credentials_rsaparams` και ξανά το [§10.1](#101-εγγραφή-του-runner) βήματα 4–5 |
| Το job βγαίνει 🔴 στο `git pull` | τοπικές αλλαγές σε αρχεία στο VM | `cd ~/thesis-workstations && git status`. Αναίρεσε τις αλλαγές με `git checkout -- <αρχείο>` |
| Το job βγαίνει 🔴 με «Λείπει το .env» | δεν υπάρχει το `manager/.env` | [§6.4](#64-managerenv) |
| Στο log: «Δεν υπάρχει passwordless sudo» | δεν έγινε το [§8](#8-vm-δικαιώματα-για-το-deploy-sudoers) | κάνε το §8 |
| `kubectl` → `permission denied` στο `k3s.yaml` | δεν ορίστηκε το `KUBECONFIG` | [§5.3](#53-k3s-kubernetes) (το κομμάτι «χωρίς sudo») |
| Ο Manager δεν ξεκινά: `ERR_REQUIRE_ESM` | παλιό Node.js | `node -v` πρέπει ≥ 20.19, δες το [§5.4](#54-nodejs-20-lts-από-το-nodesource) |
| Ο Manager δεν ξεκινά: `password authentication failed` | διαφορετικός κωδικός σε `manager/.env` και `database/.env` | βάλε τον ίδιο κωδικό και τρέξε `pm2 restart manager` |
| Μετά από reboot ο Manager δεν τρέχει | δεν έγινε το `pm2 startup` | [§9.1](#91-αυτόματη-εκκίνηση-του-manager-μετά-από-reboot) |
| Το portal ζητά login αλλά δεν υπάρχει λογαριασμός | δεν δημιουργήθηκε ο πρώτος admin | [§9.3](#93-πρώτος-λογαριασμός-admin) |
| «Πολλές αποτυχημένες προσπάθειες» στο login | 5 λάθος κωδικοί σε 15 λεπτά (προστασία από brute-force) | περίμενε 15 λεπτά ή `pm2 restart manager` |
| Ο Manager δεν ξεκινά: `Database migrations failed` | σφάλμα στο σχήμα της βάσης | `pm2 logs manager` για τη λεπτομέρεια. Τα migrations βρίσκονται στο `database/migrations/` |
| Το VS Code δεν ανοίγει με το link | το link άνοιξε χωρίς το `tkn=` ή το workstation έληξε | άνοιξέ το ξανά από το portal («Τα workstations μου») |

---

## 15. Ασφάλεια

- **Μόνο σε LAN.** Μην κάνεις port forwarding από το router προς τις θύρες 5000, 5432 ή 30000–32767. Το portal και το `/admin` προστατεύονται με login και ρόλους. Κάθε VS Code ανοίγει μόνο με το μυστικό token του. Όμως τα workstations είναι ακόμα **σκόπιμα χωρίς hardening** του Pod (securityContext, NetworkPolicies), και η σύνδεση είναι HTTP χωρίς κρυπτογράφηση. Και τα δύο είναι αντικείμενο της επόμενης φάσης.
- Σε HTTPS (π.χ. στο cloud πίσω από TLS) βάλε `COOKIE_SECURE=true` στο `manager/.env`.
- Χρησιμοποίησε **δικούς σου, ισχυρούς κωδικούς** (VM, βάση) και **μην κάνεις commit** αρχεία `.env`.
- Ο κανόνας sudo του [§8](#8-vm-δικαιώματα-για-το-deploy-sudoers) δίνει πρόσβαση στο `docker`, που πρακτικά ισοδυναμεί με root στο VM. Είναι αποδεκτό για εργαστήριο, όχι για παραγωγή.
- Αν θες απομακρυσμένη πρόσβαση στο VM, χρησιμοποίησε VPN (π.χ. Tailscale ή WireGuard) και όχι δημόσιες θύρες.
