// One-time setup. Run: node setup.mjs
// Asks for your [vault] password and Backblaze keys (typed privately, never shown or saved here),
// stores them as Cloudflare secrets, and configures the B2 bucket for browser uploads.
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Run from the project folder (where wrangler.toml is), wherever the terminal started.
process.chdir(dirname(fileURLToPath(import.meta.url)));

const APP_ORIGIN = 'https://vault.choseroxy.workers.dev';
const BUCKET_ID = '6a87eedb033d3ed1a6160517';

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hidden answers echo one * per keystroke; the prompt and the final line break still print normally.
    if (hidden) {
      rl._writeToOutput = s => {
        if (s.startsWith(question)) process.stdout.write(question);
        else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
        else if (s.length) process.stdout.write('*');
      };
    }
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// Saves all secrets in one go via a short-lived private file, deleted straight after.
// (Piping values into wrangler makes it think it's non-interactive, which disables your saved login.)
function saveSecrets(secrets) {
  const file = join(mkdtempSync(join(tmpdir(), 'vault-')), 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const r = spawnSync(`npx wrangler secret bulk "${file}"`, { stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error("Couldn't save the secrets to Cloudflare (see the error above).");
  } finally {
    rmSync(dirname(file), { recursive: true, force: true });
  }
}

async function authorize(keyId, key) {
  const auth = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${key}`).toString('base64') },
  }).then(r => r.json());
  return auth.authorizationToken ? auth : null;
}

// Keeps asking until Backblaze accepts the keyID + applicationKey pair.
async function askKey(label) {
  for (;;) {
    const keyId = await ask(`  ${label}keyID: `);
    const key = await ask(`  ${label}applicationKey: `, true);
    const auth = await authorize(keyId, key);
    if (auth) return { keyId, key, auth };
    console.log("  Backblaze didn't accept that keyID + applicationKey pair. Check both and try again.");
  }
}

function updateBucket(auth) {
  return fetch(auth.apiInfo.storageApi.apiUrl + '/b2api/v3/b2_update_bucket', {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketId: BUCKET_ID,
      // Lets the app upload and play straight from your browser.
      corsRules: [{
        corsRuleName: 'vault-app',
        allowedOrigins: [APP_ORIGIN],
        allowedOperations: ['s3_get', 's3_head', 's3_put'],
        allowedHeaders: ['content-type', 'range'],
        exposeHeaders: ['content-length', 'content-range', 'etag'],
        maxAgeSeconds: 3600,
      }],
      // "Keep only the last version": deleted files are really removed, so space is freed.
      lifecycleRules: [{ fileNamePrefix: '', daysFromHidingToDeleting: 1, daysFromUploadingToHiding: null }],
    }),
  }).then(r => r.json());
}

// `node setup.mjs google`: only the Google Drive sign-in (for invited accounts). Leaves everything else as it is.
if (process.argv[2] === 'google') {
  console.log(`\nGoogle Cloud console → APIs & Services → Credentials → your OAuth client (Web application).
Its Authorized redirect URI must be exactly: ${APP_ORIGIN}/api/drive/callback\n`);
  const id = await ask('Client ID: '), secret = await ask('Client secret: ', true);
  if (!/\.apps\.googleusercontent\.com$/.test(id) || !secret) { console.error("\nThat doesn't look like a Google OAuth client ID and secret.\n"); process.exit(1); }
  saveSecrets({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
  console.log('\nDone! Invited accounts can now connect Google Drive.\n');
  process.exit(0);
}

// `node setup.mjs email`: email you when someone asks for an invite (Resend, free). Leaves everything else as it is.
if (process.argv[2] === 'email') {
  console.log(`\nresend.com → sign up (free) → API Keys → Create API key (Sending access).
Use the email address you signed up to Resend with: Resend's free sender can only email that address.\n`);
  const key = await ask('Resend API key: ', true), to = (await ask('Your email address: ')).trim();
  if (!/^re_/.test(key) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { console.error("\nThat doesn't look like a Resend key (re_...) and an email address.\n"); process.exit(1); }
  saveSecrets({ RESEND_API_KEY: key, NOTIFY_EMAIL: to });
  console.log('\nDone! Invite requests will be emailed to you.\n');
  process.exit(0);
}

try {
  console.log('\n[vault] setup — nothing you type here is shown or sent anywhere except Cloudflare and Backblaze.\n');

  let pw = '';
  for (;;) {
    pw = await ask('Choose your [vault] password: ', true);
    if (pw.length < 10) { console.log('  Use at least 10 characters.'); continue; }
    if ((await ask('Type it again: ', true)) === pw) break;
    console.log("  Those didn't match. Try again.");
  }

  console.log('\nYour Backblaze bucket key (Application Keys page, the one limited to untitled-vault):');
  const { keyId, key, auth } = await askKey('');
  const caps = auth.apiInfo.storageApi.capabilities || [];
  if (!caps.includes('writeFiles') || !caps.includes('readFiles')) {
    throw new Error('That key needs Read and Write access. Make a new key with "Read and Write" for untitled-vault.');
  }

  console.log('\nConfiguring the bucket…');
  let res = await updateBucket(auth);
  if (res.code === 'unauthorized') {
    console.log("  This key isn't allowed to change bucket settings (that's normal).");
    console.log('  Enter your Master Application Key (Application Keys page, top section). It is used once and not saved.');
    res = await updateBucket((await askKey('master ')).auth);
  }
  if (res.code) throw new Error(`Backblaze refused the bucket settings: ${res.message || res.code}`);
  console.log('  bucket ready (uploads allowed from your app, old versions cleaned up)');

  console.log('\nSaving secrets to Cloudflare…');
  saveSecrets({ APP_PASSWORD: pw, B2_KEY_ID: keyId, B2_APP_KEY: key });

  console.log(`\nDone! Open ${APP_ORIGIN} and log in.\n`);
} catch (e) {
  console.error(`\nSetup stopped: ${e.message}\nFix that and run setup again; it's safe to repeat.\n`);
  process.exit(1);
}
