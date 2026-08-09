// Φόρτωση του dotenv ορίζοντας ρητά το path του αρχείου .env
require('dotenv').config({ path: __dirname + '/.env' });
const k8s = require('@kubernetes/client-node');

// Fail Fast Έλεγχος: Αν δεν οριστεί namespace, η εφαρμογή σταματάει αμέσως με μήνυμα λάθους
if (!process.env.K8S_NAMESPACE) {
    console.error("[CRITICAL] K8S_NAMESPACE is missing from the .env configuration file.");
    process.exit(1);
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

console.log(`[K8s] Kubernetes client successfully initialized. Target Namespace: ${process.env.K8S_NAMESPACE}`);

module.exports = {
    k8sCoreApi,
    k8sAppsApi,
    k8sNamespace: process.env.K8S_NAMESPACE
};
