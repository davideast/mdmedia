#!/usr/bin/env node

/**
 * Production deployment preflight check (`npm --prefix studio run deploy:preflight`).
 *
 * Fails with `process.exit(1)` if:
 * 1. `NEXT_PUBLIC_PYRIC_GEMINI_API_KEY` is set in the environment (prevents
 *    shipping a Gemini API key in the client bundle).
 * 2. Any file under `studio/src/` imports or references `firebase/ai` (AI Logic
 *    must remain disabled; all synthesis goes through Cloud Run).
 * 3. `firestore.rules` or `storage.rules` drifted from `firestore.modules.rules`
 *    or `storage.modules.rules` when resolved via `pyric ... rules resolve`.
 * 4. Offline replay verification (`rules:verify`) or hosted Firebase Rules Test
 *    API verification (`rules:verify:hosted`) fails.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(STUDIO_DIR, 'src');

function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

function main() {
  console.log('=== Deploy Preflight Check ===\n');

  // 1. Refuse browser Gemini key exposure
  if (process.env.NEXT_PUBLIC_PYRIC_GEMINI_API_KEY) {
    console.error(
      '✗ Refusing deploy: NEXT_PUBLIC_PYRIC_GEMINI_API_KEY is set in the environment.',
    );
    process.exit(1);
  }
  console.log('✓ NEXT_PUBLIC_PYRIC_GEMINI_API_KEY is unset');

  // 2. Refuse any client-side firebase/ai usage
  for (const file of walkFiles(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('firebase/ai')) {
      console.error(
        `✗ Refusing deploy: forbidden client AI import "firebase/ai" found in ${path.relative(STUDIO_DIR, file)}.`,
      );
      process.exit(1);
    }
  }
  console.log('✓ Zero "firebase/ai" references in studio/src');

  // 3. Verify compiled rules artifacts match *.modules.rules byte-for-byte
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'rules-preflight-'));
  try {
    const tmpFirestore = path.join(tmpDir, 'firestore.rules');
    const tmpStorage = path.join(tmpDir, 'storage.rules');

    execSync(
      `npx pyric firestore rules resolve firestore.modules.rules --out "${tmpFirestore}"`,
      { cwd: STUDIO_DIR, stdio: 'pipe' },
    );
    execSync(
      `npx pyric storage rules resolve storage.modules.rules --out "${tmpStorage}"`,
      { cwd: STUDIO_DIR, stdio: 'pipe' },
    );

    const committedFirestore = readFileSync(path.join(STUDIO_DIR, 'firestore.rules'), 'utf8');
    const resolvedFirestore = readFileSync(tmpFirestore, 'utf8');
    if (committedFirestore !== resolvedFirestore) {
      console.error(
        '✗ Refusing deploy: firestore.rules drifted from firestore.modules.rules. Run `npm --prefix studio run rules:build`.',
      );
      process.exit(1);
    }

    const committedStorage = readFileSync(path.join(STUDIO_DIR, 'storage.rules'), 'utf8');
    const resolvedStorage = readFileSync(tmpStorage, 'utf8');
    if (committedStorage !== resolvedStorage) {
      console.error(
        '✗ Refusing deploy: storage.rules drifted from storage.modules.rules. Run `npm --prefix studio run rules:build`.',
      );
      process.exit(1);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('✓ firestore.rules and storage.rules match *.modules.rules');

  // 4. Run offline and hosted rules verification
  try {
    console.log('\n--- Running rules:verify ---');
    execSync('npm run rules:verify', { cwd: STUDIO_DIR, stdio: 'inherit' });
    console.log('\n--- Running rules:verify:hosted ---');
    execSync('npm run rules:verify:hosted', { cwd: STUDIO_DIR, stdio: 'inherit' });
  } catch {
    console.error('\n✗ Refusing deploy: rules verification failed.');
    process.exit(1);
  }

  console.log('\n✓ Deploy preflight passed.');
}

main();
