#!/usr/bin/env node

/** Remove legacy ElevenLabs IDs from narration documents that can be shared. */
import { fileURLToPath } from 'node:url';

export function hasLegacyPrivateVoiceId(data) {
  return data?.voiceProvider === 'elevenlabs'
    && Object.hasOwn(data, 'voiceId');
}

export async function scrubLegacyVoiceIds(db, deleteSentinel, apply) {
  let cursor;
  let scanned = 0;
  let matched = 0;
  let changed = 0;
  do {
    let query = db.collection('narrations').orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const snap of page.docs) {
      scanned += 1;
      if (!hasLegacyPrivateVoiceId(snap.data())) continue;
      matched += 1;
      if (apply) {
        // A newer write wins: never remove a field from a document that changed
        // after this read. The operator can rerun the command if that happens.
        await snap.ref.update({ voiceId: deleteSentinel }, { lastUpdateTime: snap.updateTime });
        changed += 1;
      }
    }
    cursor = page.docs.at(-1);
    if (page.size < 100) break;
  } while (true);
  return { scanned, matched, changed };
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help') {
    console.log('Usage: node scripts/scrub-private-voice-ids.mjs --cloud <project-id> [--apply]');
    return;
  }
  const [mode, projectId, action] = argv;
  if (mode !== '--cloud' || !projectId || (action !== undefined && action !== '--apply') || argv.length > 3) {
    throw new Error('Usage: node scripts/scrub-private-voice-ids.mjs --cloud <project-id> [--apply]');
  }
  const { applicationDefault, initializeApp } = await import('firebase-admin/app');
  const { FieldValue, getFirestore } = await import('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId });
  const { scanned, matched, changed } = await scrubLegacyVoiceIds(
    getFirestore(app), FieldValue.delete(), action === '--apply');
  console.log(`${projectId}: scanned ${scanned}; legacy ElevenLabs IDs ${matched}; removed ${changed}${action === '--apply' ? '' : ' (dry run)'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
