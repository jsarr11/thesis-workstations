// Κανονικοποιημένο JSON (ταξινομημένα κλειδιά) και SHA-256, ώστε το ίδιο manifest να δίνει πάντα το ίδιο hash.
const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

module.exports = { canonicalJson, sha256 };
