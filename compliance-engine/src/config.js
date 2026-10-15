// Ρυθμίσεις από το compliance-engine/.env και τις μεταβλητές περιβάλλοντος (οι δεύτερες έχουν προτεραιότητα).
// Χωρίς εξωτερικές βιβλιοθήκες, ώστε το εργαλείο να μεταφέρεται χωρίς εξαρτήσεις.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENGINE_DIR = path.join(__dirname, '..');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

// kubeconfig για τον έλεγχο του cluster: ρητή ρύθμιση, αλλιώς ~/.kube/config αν υπάρχει (αλλιώς η προεπιλογή του kubectl)
function defaultKubeconfig() {
  const file = path.join(os.homedir(), '.kube', 'config');
  return fs.existsSync(file) ? file : '';
}

function loadConfig(env = process.env, envFile = path.join(ENGINE_DIR, '.env')) {
  const values = { ...readEnvFile(envFile), ...env };
  const config = {
    host: values.HOST || '127.0.0.1',
    port: Number.parseInt(values.PORT || '5100', 10),
    apiKey: values.API_KEY || '',
    dataDir: path.resolve(ENGINE_DIR, values.DATA_DIR || 'data'),
    cluster: {
      kubectl: values.KUBECTL || 'kubectl',
      kubeconfig: values.KUBECONFIG || defaultKubeconfig(),
      // Namespaces των workloads, των οποίων ελέγχονται τα labels του Pod Security Admission
      namespaces: (values.CLUSTER_NAMESPACES || 'workstations').split(',').map((s) => s.trim()).filter(Boolean),
      scanNamespace: values.CLUSTER_SCAN_NAMESPACE || 'compliance-system',
      kubeBenchImage: values.KUBE_BENCH_IMAGE || 'docker.io/aquasec/kube-bench:v0.15.6',
      kubeBenchBenchmark: values.KUBE_BENCH_BENCHMARK || '', // κενό = αυτόματη αναγνώριση (π.χ. k3s-cis-1.x)
      scanTimeoutSeconds: Number.parseInt(values.CLUSTER_SCAN_TIMEOUT_SECONDS || '300', 10),
    },
  };
  if (config.apiKey.length < 32) {
    throw new Error('API_KEY is missing or shorter than 32 characters (see compliance-engine/.env.example)');
  }
  if (!Number.isInteger(config.port) || config.port <= 0) throw new Error('PORT must be a positive integer');
  return config;
}

module.exports = { loadConfig, ENGINE_DIR };
