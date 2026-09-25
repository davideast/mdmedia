#!/usr/bin/env node

/**
 * CLI for managing the `allowlist/{email}` collection in Firestore.
 *
 * Defaults to the production Firebase project (`mdmedia-dev` from `studio/.firebaserc`
 * or `--project <id>`), authenticating with either:
 * 1. Your active Firebase CLI login (`~/.config/configstore/firebase-tools.json`), or
 * 2. `GOOGLE_APPLICATION_CREDENTIALS` via `firebase-admin`.
 *
 * Pass `--local` to target the local Pyric sandbox instead.
 *
 * Usage:
 *   bun run studio:allowlist deast@google.com dceast@gmail.com
 *   bun run studio:allowlist add alice@example.com --note "Core team"
 *   bun run studio:allowlist set deast@google.com dceast@gmail.com
 *   bun run studio:allowlist remove eve@example.com
 *   bun run studio:allowlist list
 *   bun run studio:allowlist check deast@google.com
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_DIR = path.resolve(__dirname, '..');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PROD_PROJECT_ID = 'mdmedia-dev';

/**
 * Load key=value pairs from `studio/.env.local` into `process.env` without
 * overwriting variables already set in the caller's environment.
 */
function loadEnvLocal() {
  const envPath = path.join(STUDIO_DIR, '.env.local');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== '') {
      process.env[key] = value;
    }
  }
}

function readFirebaseRcProject() {
  for (const candidate of [
    path.join(STUDIO_DIR, '.firebaserc'),
    path.join(STUDIO_DIR, '..', '.firebaserc'),
  ]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const def = parsed?.projects?.default;
      if (typeof def === 'string' && def.trim()) {
        return def.trim();
      }
    } catch {
      // ignore malformed .firebaserc
    }
  }
  return '';
}

export function normalizeEmail(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return EMAIL_REGEX.test(email);
}

export function parseArgs(argv) {
  const positional = [];
  const options = {
    local: false,
    cloud: false,
    sandboxUrl: process.env.PYRIC_SANDBOX || '',
    projectId: '',
    note: '',
    revokeTokens: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local') {
      options.local = true;
    } else if (arg === '--cloud' || arg === '--prod' || arg === '--production') {
      options.cloud = true;
    } else if (arg === '--sandbox') {
      options.local = true;
      options.sandboxUrl = argv[++i] ?? '';
    } else if (arg.startsWith('--sandbox=')) {
      options.local = true;
      options.sandboxUrl = arg.slice('--sandbox='.length);
    } else if (arg === '--project' || arg === '-p') {
      options.projectId = argv[++i] ?? '';
    } else if (arg.startsWith('--project=')) {
      options.projectId = arg.slice('--project='.length);
    } else if (arg === '--note' || arg === '-n') {
      options.note = argv[++i] ?? '';
    } else if (arg.startsWith('--note=')) {
      options.note = arg.slice('--note='.length);
    } else if (arg === '--revoke-tokens') {
      options.revokeTokens = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  let command = positional[0] ?? 'list';
  let emails = positional.slice(1);

  // Shorthand: if the first positional argument is an email address, treat it as `add`.
  if (command.includes('@')) {
    emails = [command, ...emails];
    command = 'add';
  }

  return { command, emails, options };
}

function printHelp() {
  console.log(`Usage:
  bun run studio:allowlist <command> [emails...] [options]
  bun run studio:allowlist <email...>

Commands:
  add <email...>       Add one or more emails to allowlist/{email}
  set <email...>       Replace the allowlist so only the given emails are allowlisted
  remove <email...>    Remove one or more emails from allowlist/{email} (aliases: rm, delete, revoke)
  list                 List all allowlisted emails (alias: ls)
  check <email...>     Verify whether each email is currently allowlisted

Options:
  --note, -n <text>    Optional note stored on the allowlist document
  --revoke-tokens      Also revoke Firebase Auth refresh tokens when removing an email
  --project, -p <id>   Firebase project ID (defaults to "${DEFAULT_PROD_PROJECT_ID}" from studio/.firebaserc)
  --cloud, --prod      Target production Cloud Firestore (default)
  --local              Target the local Pyric sandbox instead of Cloud Firestore
  --sandbox <url>      Target a custom Pyric sandbox URL
  --json               Print output as JSON
  --help, -h           Show this help message
`);
}

function validateEmails(rawEmails) {
  if (rawEmails.length === 0) {
    throw new Error('At least one email address is required.');
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of rawEmails) {
    for (const part of raw.split(',')) {
      const email = normalizeEmail(part);
      if (!email) continue;
      if (!isValidEmail(email)) {
        throw new Error(`Invalid email address: "${part}"`);
      }
      if (!seen.has(email)) {
        seen.add(email);
        normalized.push(email);
      }
    }
  }
  if (normalized.length === 0) {
    throw new Error('At least one valid email address is required.');
  }
  return normalized;
}

/**
 * Retrieve a valid OAuth2 access token from the Firebase CLI configstore
 * (`~/.config/configstore/firebase-tools.json`), automatically refreshing via
 * the `firebase` CLI if the cached access token is expired.
 */
function getFirebaseCliAccessToken() {
  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let cfg = readConfig();
  let tokens = cfg?.tokens;
  if (!tokens?.access_token && !tokens?.refresh_token) {
    return null;
  }

  const expiresAt = typeof tokens.expires_at === 'number' ? tokens.expires_at : 0;
  if (!tokens.access_token || expiresAt < Date.now() + 60_000) {
    try {
      execFileSync('firebase', ['projects:list', '--json'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
      cfg = readConfig();
      tokens = cfg?.tokens;
    } catch {
      // If firebase CLI refresh failed, still return token if present
    }
  }

  return tokens?.access_token
    ? { accessToken: tokens.access_token, userEmail: cfg?.user?.email ?? 'firebase-cli' }
    : null;
}

function toFirestoreFields(record) {
  const fields = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      fields[k] = { stringValue: v };
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      fields[k] = { integerValue: String(v) };
    } else if (typeof v === 'number') {
      fields[k] = { doubleValue: v };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    }
  }
  return fields;
}

function fromFirestoreFields(fields = {}) {
  const out = {};
  for (const [k, val] of Object.entries(fields)) {
    if ('stringValue' in val) out[k] = val.stringValue;
    else if ('integerValue' in val) out[k] = Number(val.integerValue);
    else if ('doubleValue' in val) out[k] = Number(val.doubleValue);
    else if ('booleanValue' in val) out[k] = Boolean(val.booleanValue);
  }
  return out;
}

/**
 * Minimal Firestore + Auth client backed by the Cloud Firestore v1 REST API
 * using the user's `firebase login` OAuth token.
 */
function createFirebaseCliRestBackend(projectId, accessToken, userEmail) {
  const firestoreHost = ['firestore', 'googleapis', 'com'].join('.');
  const identityHost = ['identitytoolkit', 'googleapis', 'com'].join('.');
  const baseUrl = `https://${firestoreHost}/v1/projects/${encodeURIComponent(
    projectId,
  )}/databases/(default)/documents`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  function makeDocRef(collectionName, docId) {
    const docUrl = `${baseUrl}/${encodeURIComponent(collectionName)}/${encodeURIComponent(docId)}`;
    return {
      id: docId,
      async get() {
        const res = await fetch(docUrl, { headers });
        if (res.status === 404) {
          return { id: docId, exists: false, data: () => undefined };
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Firestore GET ${collectionName}/${docId} failed (${res.status}): ${text}`);
        }
        const json = await res.json();
        const data = fromFirestoreFields(json.fields);
        return { id: docId, exists: true, data: () => data };
      },
      async set(record) {
        const body = JSON.stringify({ fields: toFirestoreFields(record) });
        const res = await fetch(docUrl, { method: 'PATCH', headers, body });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Firestore PATCH ${collectionName}/${docId} failed (${res.status}): ${text}`,
          );
        }
      },
      async delete() {
        const res = await fetch(docUrl, { method: 'DELETE', headers });
        if (!res.ok && res.status !== 404) {
          const text = await res.text();
          throw new Error(
            `Firestore DELETE ${collectionName}/${docId} failed (${res.status}): ${text}`,
          );
        }
      },
    };
  }

  const db = {
    collection(collectionName) {
      return {
        doc(docId) {
          return makeDocRef(collectionName, docId);
        },
        async get() {
          const docs = [];
          let pageToken = '';
          do {
            const url = `${baseUrl}/${encodeURIComponent(collectionName)}${
              pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
            }`;
            const res = await fetch(url, { headers });
            if (!res.ok) {
              const text = await res.text();
              throw new Error(
                `Firestore LIST ${collectionName} failed (${res.status}): ${text}`,
              );
            }
            const json = await res.json();
            for (const rawDoc of json.documents ?? []) {
              const id = String(rawDoc.name ?? '').split('/').pop() ?? '';
              const data = fromFirestoreFields(rawDoc.fields);
              docs.push({ id, exists: true, data: () => data });
            }
            pageToken = json.nextPageToken ?? '';
          } while (pageToken);
          return { docs };
        },
      };
    },
  };

  const auth = {
    async getUserByEmail(email) {
      const url = `https://${identityHost}/v1/projects/${encodeURIComponent(
        projectId,
      )}/accounts:lookup`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: [email] }),
      });
      if (!res.ok) throw new Error(`Auth lookup failed (${res.status})`);
      const json = await res.json();
      const user = json.users?.[0];
      if (!user?.localId) throw new Error('auth/user-not-found');
      return { uid: user.localId };
    },
    async revokeRefreshTokens(uid) {
      const url = `https://${identityHost}/v1/projects/${encodeURIComponent(
        projectId,
      )}/accounts:update`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ localId: uid, validSince: Math.floor(Date.now() / 1000) }),
      });
      if (!res.ok) throw new Error(`Auth token revocation failed (${res.status})`);
    },
  };

  return {
    db,
    auth,
    projectId,
    actor: userEmail,
    targetLabel: `cloud Firestore (${projectId} via Firebase CLI as ${userEmail})`,
    close: async () => {},
  };
}

async function openBackend(options) {
  loadEnvLocal();

  if (!options.local) {
    const rcProject = readFirebaseRcProject();
    const envProject =
      process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== 'mdmedia-studio'
        ? process.env.FIREBASE_PROJECT_ID
        : '';
    const projectId = options.projectId || rcProject || envProject || DEFAULT_PROD_PROJECT_ID;

    const hasServiceAccountFile = Boolean(
      process.env.GOOGLE_APPLICATION_CREDENTIALS &&
        fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    );

    if (hasServiceAccountFile) {
      const { getApps, initializeApp, applicationDefault } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      const { getAuth } = await import('firebase-admin/auth');

      const app =
        getApps()[0] ??
        initializeApp({
          projectId,
          credential: applicationDefault(),
        });

      return {
        db: getFirestore(app),
        auth: getAuth(app),
        projectId,
        actor: os.userInfo().username || 'cli',
        targetLabel: `cloud Firestore (${projectId} via service account)`,
        close: async () => {},
      };
    }

    const cliToken = getFirebaseCliAccessToken();
    if (cliToken) {
      return createFirebaseCliRestBackend(projectId, cliToken.accessToken, cliToken.userEmail);
    }

    throw new Error(
      `Not logged in to Firebase CLI and GOOGLE_APPLICATION_CREDENTIALS is not set. Run \`firebase login\` or pass \`--local\` for the Pyric sandbox.`,
    );
  }

  // Local Pyric mode (`--local`)
  const projectId =
    options.projectId ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    'mdmedia-studio';

  const { discoverServe } = await import(
    '../node_modules/@pyric/cli/dist/serve/discovery.js'
  );
  const { connectRemoteSandbox } = await import(
    '../node_modules/@pyric/cli/dist/remote/index.js'
  );
  const { initializeApp, deleteApp } = await import('pyric-admin/app');
  const { getFirestore } = await import('pyric-admin/firestore');
  const { getAuth } = await import('pyric-admin/auth');

  const explicitUrl = options.sandboxUrl.replace(/^remote:/, '').trim();
  const discovered = explicitUrl
    ? { url: explicitUrl, source: 'explicit' }
    : await discoverServe(STUDIO_DIR);

  if (discovered && (explicitUrl || discovered.source.startsWith('pointer'))) {
    try {
      const remoteHandle = await connectRemoteSandbox({
        cwd: STUDIO_DIR,
        url: discovered.url,
      });
      const app = initializeApp({ sandbox: remoteHandle }, `allowlist-remote-${Date.now()}`);
      return {
        db: getFirestore(app),
        auth: getAuth(app),
        projectId,
        actor: os.userInfo().username || 'cli',
        targetLabel: `pyric live sandbox (${discovered.url})`,
        close: async () => {
          await deleteApp(app).catch(() => {});
          remoteHandle.close();
        },
      };
    } catch {
      // Fall through to offline hosted SQLite persistence if live server is unreachable
    }
  }

  const { createHostedPersistence, HOSTED_NAMESPACE } = await import(
    '../node_modules/@pyric/cli/dist/serve/hosted/persistence.js'
  );
  const { SERVE_HISTORY_LIMITS } = await import(
    '../node_modules/@pyric/cli/dist/serve/observation-limits.js'
  );
  const { createSandboxRoot } = await import('pyric/sandbox/internal');
  const { installStorageBackend } = await import('pyric/storage/internal');

  const realStudioDir = fs.realpathSync(STUDIO_DIR);
  const persistence = await createHostedPersistence(realStudioDir);
  const sandbox = createSandboxRoot(SERVE_HISTORY_LIMITS);
  installStorageBackend(sandbox, persistence.storage);
  await sandbox.enablePersistence({
    key: HOSTED_NAMESPACE,
    injectedBackend: persistence.backend,
  });

  const app = initializeApp({ sandbox }, `allowlist-hosted-${Date.now()}`);
  const sqliteRelative = path.relative(process.cwd(), persistence.state.path);

  return {
    db: getFirestore(app),
    auth: getAuth(app),
    projectId,
    actor: os.userInfo().username || 'cli',
    targetLabel: `pyric local store (${sqliteRelative})`,
    close: async () => {
      await sandbox.flush();
      await deleteApp(app).catch(() => {});
      sandbox.dispose();
      persistence.close();
    },
  };
}

async function main() {
  const { command, emails: rawEmails, options } = parseArgs(process.argv.slice(2));

  if (options.help || command === 'help') {
    printHelp();
    return;
  }

  const backend = await openBackend(options);
  const { db, auth, projectId, actor, targetLabel } = backend;

  try {
    const collection = db.collection('allowlist');
    const now = Date.now();

    switch (command) {
      case 'add': {
        const emails = validateEmails(rawEmails);
        const results = [];

        for (const email of emails) {
          const docRef = collection.doc(email);
          const existing = await docRef.get();
          const existingData = existing.exists ? existing.data() ?? {} : {};
          const record = {
            email,
            addedAt: typeof existingData.addedAt === 'number' ? existingData.addedAt : now,
            updatedAt: now,
            addedBy: existingData.addedBy ?? actor,
            ...(options.note
              ? { note: options.note }
              : existingData.note
                ? { note: existingData.note }
                : {}),
          };
          await docRef.set(record, { merge: true });
          results.push({ email, status: existing.exists ? 'updated' : 'added', ...record });
        }

        if (options.json) {
          console.log(JSON.stringify({ ok: true, projectId, target: targetLabel, results }, null, 2));
        } else {
          console.log(`Target: ${targetLabel}`);
          for (const r of results) {
            console.log(`✓ [${r.status}] allowlist/${r.email}${r.note ? ` (${r.note})` : ''}`);
          }
        }
        break;
      }

      case 'set':
      case 'sync': {
        const desiredEmails = validateEmails(rawEmails);
        const desiredSet = new Set(desiredEmails);

        const snapshot = await collection.get();
        const existingIds = new Set(snapshot.docs.map((d) => d.id));

        const added = [];
        const kept = [];
        const removed = [];

        for (const email of desiredEmails) {
          const docRef = collection.doc(email);
          const existingDoc = snapshot.docs.find((d) => d.id === email);
          const existingData = existingDoc ? existingDoc.data() ?? {} : {};
          const record = {
            email,
            addedAt: typeof existingData.addedAt === 'number' ? existingData.addedAt : now,
            updatedAt: now,
            addedBy: existingData.addedBy ?? actor,
            ...(options.note
              ? { note: options.note }
              : existingData.note
                ? { note: existingData.note }
                : {}),
          };
          await docRef.set(record, { merge: true });
          if (existingIds.has(email)) {
            kept.push(email);
          } else {
            added.push(email);
          }
        }

        for (const docSnap of snapshot.docs) {
          if (!desiredSet.has(docSnap.id)) {
            await collection.doc(docSnap.id).delete();
            removed.push(docSnap.id);
          }
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              { ok: true, projectId, target: targetLabel, added, kept, removed, total: desiredEmails.length },
              null,
              2,
            ),
          );
        } else {
          console.log(`Target: ${targetLabel}`);
          console.log(
            `✓ Synced allowlist (${desiredEmails.length} total: ${added.length} added, ${kept.length} kept, ${removed.length} removed)`,
          );
          for (const email of added) console.log(`  + ${email}`);
          for (const email of kept) console.log(`  = ${email}`);
          for (const email of removed) console.log(`  - ${email}`);
        }
        break;
      }

      case 'remove':
      case 'rm':
      case 'delete':
      case 'revoke': {
        const emails = validateEmails(rawEmails);
        const results = [];

        for (const email of emails) {
          const docRef = collection.doc(email);
          const existing = await docRef.get();
          await docRef.delete();

          let tokensRevoked = false;
          if (options.revokeTokens) {
            try {
              const userRecord = await auth.getUserByEmail(email);
              await auth.revokeRefreshTokens(userRecord.uid);
              tokensRevoked = true;
            } catch {
              // User may not have signed in yet or may not exist in Auth
            }
          }

          results.push({
            email,
            existed: existing.exists,
            tokensRevoked,
          });
        }

        if (options.json) {
          console.log(JSON.stringify({ ok: true, projectId, target: targetLabel, results }, null, 2));
        } else {
          console.log(`Target: ${targetLabel}`);
          for (const r of results) {
            const suffix = r.tokensRevoked ? ' (refresh tokens revoked)' : '';
            console.log(
              `✓ [${r.existed ? 'removed' : 'already absent'}] allowlist/${r.email}${suffix}`,
            );
          }
        }
        break;
      }

      case 'list':
      case 'ls': {
        const snapshot = await collection.get();
        const entries = snapshot.docs
          .map((docSnap) => {
            const data = docSnap.data() ?? {};
            return {
              email: docSnap.id,
              addedAt: typeof data.addedAt === 'number' ? data.addedAt : null,
              addedBy: typeof data.addedBy === 'string' ? data.addedBy : null,
              note: typeof data.note === 'string' ? data.note : null,
            };
          })
          .sort((a, b) => a.email.localeCompare(b.email));

        if (options.json) {
          console.log(
            JSON.stringify({ ok: true, projectId, target: targetLabel, count: entries.length, entries }, null, 2),
          );
        } else {
          console.log(`Target: ${targetLabel}`);
          if (entries.length === 0) {
            console.log(`No allowlisted users found in project "${projectId}".`);
          } else {
            console.log(`Allowlisted users in "${projectId}" (${entries.length}):`);
            for (const entry of entries) {
              const dateStr = entry.addedAt
                ? new Date(entry.addedAt).toISOString().slice(0, 10)
                : 'unknown';
              const noteStr = entry.note ? ` — ${entry.note}` : '';
              console.log(`  • ${entry.email} (added ${dateStr})${noteStr}`);
            }
          }
        }
        break;
      }

      case 'check': {
        const emails = validateEmails(rawEmails);
        const results = [];
        let allAllowed = true;

        for (const email of emails) {
          const snap = await collection.doc(email).get();
          const allowed = snap.exists;
          if (!allowed) allAllowed = false;
          results.push({ email, allowed, data: snap.exists ? snap.data() : null });
        }

        if (options.json) {
          console.log(JSON.stringify({ ok: allAllowed, projectId, target: targetLabel, results }, null, 2));
        } else {
          console.log(`Target: ${targetLabel}`);
          for (const r of results) {
            console.log(`${r.allowed ? '✓ ALLOWLISTED' : '✗ NOT ALLOWLISTED'}  ${r.email}`);
          }
        }

        if (!allAllowed) {
          process.exitCode = 1;
        }
        break;
      }

      default:
        throw new Error(`Unknown command "${command}". Run with --help for usage.`);
    }
  } finally {
    await backend.close();
  }
}

// Only execute CLI main when invoked directly (allows importing helpers in unit tests)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
