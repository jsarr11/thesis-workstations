// Δημιουργία (ή επαναφορά κωδικού) λογαριασμού admin από τη γραμμή εντολών.
// Χρήση (από τον φάκελο manager/):
//   node scripts/create-admin.js --email you@example.com --name "Ονοματεπώνυμο" --username admin
//   node scripts/create-admin.js --email you@example.com --reset      (νέος προσωρινός κωδικός)
// Ο προσωρινός κωδικός εμφανίζεται μία φορά και πρέπει να αλλάξει στην πρώτη σύνδεση.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const pool = require('../db');
const auth = require('../auth');
const { runMigrations } = require('../migrate');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reset') {
      args.reset = true;
    } else if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = String(args.email || '').trim().toLowerCase();
  if (!auth.EMAIL_PATTERN.test(email)) throw new Error('Δώσε έγκυρο --email');

  await runMigrations();
  const temporaryPassword = auth.generatePassword();
  const passwordHash = await auth.hashPassword(temporaryPassword);
  const existing = (await pool.query('SELECT id, role FROM users WHERE LOWER(email) = $1', [email])).rows[0];

  if (args.reset) {
    if (!existing) throw new Error(`Δεν υπάρχει χρήστης με email ${email}`);
    await pool.query(
      "UPDATE users SET password_hash = $2, must_change_password = TRUE, is_active = TRUE, role = 'admin' WHERE id = $1",
      [existing.id, passwordHash]
    );
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [existing.id]);
    console.log(`\n✔ Νέος προσωρινός κωδικός για ${email} (ρόλος: admin)`);
  } else {
    if (existing) throw new Error(`Υπάρχει ήδη χρήστης με email ${email} — χρησιμοποίησε --reset για νέο κωδικό`);
    const fullName = String(args.name || '').trim();
    const username = String(args.username || '').trim().toLowerCase();
    if (fullName.length < 2) throw new Error('Δώσε --name "Ονοματεπώνυμο"');
    if (!auth.USERNAME_PATTERN.test(username)) throw new Error('Το --username: μόνο πεζά λατινικά, αριθμοί και παύλα (-)');
    await pool.query(
      `INSERT INTO users (email, full_name, username, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, 'admin', $4, TRUE)`,
      [email, fullName, username, passwordHash]
    );
    console.log(`\n✔ Δημιουργήθηκε ο admin ${email} (username: ${username})`);
  }
  await pool.query(
    `INSERT INTO audit_logs (workstation_id, stage, rule_evaluated, status, details)
     VALUES (NULL, 'USER-ADMIN', $1, 'SUCCESS', $2)`,
    [args.reset ? 'PASSWORD-RESET' : 'USER-CREATED', JSON.stringify({ email, role: 'admin', via: 'create-admin.js' })]
  );
  console.log(`  Προσωρινός κωδικός: ${temporaryPassword}`);
  console.log('  (Θα ζητηθεί αλλαγή του στην πρώτη σύνδεση στο /login)\n');
}

main()
  .catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
