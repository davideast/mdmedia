#!/usr/bin/env node

/** Operator-only voice catalog and per-user grant management. No client writes. */
import { isValidEmail, normalizeEmail, openBackend } from './allowlist.mjs';

const VOICE_ID = /^[A-Za-z0-9]{20}$/;

function usage() {
  console.log(`Usage: bun run voices <command> [args] (--local | --cloud) [options]

Commands:
  shared <voice-id> <name> [--rank <number>] [--enabled --reviewed | --disabled]
  grant <email> <voice-id> <name>
  revoke <email> <voice-id>
  list [email]

Options:
  --local             Use this worktree's Pyric sandbox
  --sandbox <url>     Use a specific live Pyric sandbox (implies --local)
  --cloud             Use the configured Cloud Firestore project
  --project <id>      Override the project ID
  --reviewed          Confirm identity and permitted use before enabling

New shared voices are disabled until --enabled is given. Enabling and granting
check that the configured ElevenLabs key can retrieve the voice. Enabling a
shared voice also generates a short sample with Studio's TTS settings.`);
}

function parse(argv) {
  const args = [];
  const options = { local: false, cloud: false, sandboxUrl: '', projectId: '', rank: undefined, enabled: undefined, reviewed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local') options.local = true;
    else if (arg === '--cloud') options.cloud = true;
    else if (arg === '--sandbox') { options.local = true; options.sandboxUrl = argv[++i] ?? ''; }
    else if (arg === '--project') options.projectId = argv[++i] ?? '';
    else if (arg === '--rank') options.rank = Number(argv[++i]);
    else if (arg === '--enabled') options.enabled = true;
    else if (arg === '--disabled') options.enabled = false;
    else if (arg === '--reviewed') options.reviewed = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else args.push(arg);
  }
  if (options.local === options.cloud) throw new Error('Choose exactly one of --local or --cloud.');
  if (options.rank !== undefined && (!Number.isSafeInteger(options.rank) || options.rank < 0)) {
    throw new Error('--rank must be a nonnegative integer.');
  }
  return { command: args.shift(), args, options };
}

async function checkProviderVoice(voiceId, synthesize = false) {
  const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_LABS_KEY;
  if (!key) throw new Error('Set ELEVENLABS_API_KEY before enabling or granting a voice.');
  const response = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    headers: { 'xi-api-key': key },
  });
  if (!response.ok) throw new Error(`ElevenLabs cannot retrieve this voice with the configured key (${response.status}).`);
  if (!synthesize) return;
  const sample = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
    body: JSON.stringify({ text: 'Studio voice check.', model_id: 'eleven_multilingual_v2' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!sample.ok) throw new Error(`ElevenLabs synthesis failed with the configured key (${sample.status}).`);
  if (!sample.body) throw new Error('ElevenLabs returned no audio for the sample.');
  const reader = sample.body.getReader();
  try {
    let audioReceived = false;
    while (!audioReceived) {
      const { done, value } = await reader.read();
      if (done) throw new Error('ElevenLabs returned an empty audio sample.');
      audioReceived = value.byteLength > 0;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h') || process.argv.length <= 2) {
    usage();
    return;
  }
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) { usage(); return; }
  const { command, args, options } = parsed;
  if (!['shared', 'grant', 'revoke', 'list'].includes(command)) throw new Error('Unknown command. Run with --help.');
  if (command === 'shared' && args.length !== 2) throw new Error('shared requires <voice-id> <name>.');
  if (command === 'grant' && args.length !== 3) throw new Error('grant requires <email> <voice-id> <name>.');
  if (command === 'revoke' && args.length !== 2) throw new Error('revoke requires <email> <voice-id>.');
  if (command === 'list' && args.length > 1) throw new Error('list accepts at most one email.');
  const voiceId = command === 'shared' ? args[0] : command === 'list' ? null : args[1];
  if (voiceId && !VOICE_ID.test(voiceId)) throw new Error('ElevenLabs voice IDs must contain 20 letters or digits.');
  const name = command === 'shared' ? args[1] : command === 'grant' ? args[2] : null;
  if (name !== null && (!name.trim() || name.length > 160)) throw new Error('Voice names must contain 1–160 characters.');
  if (command === 'shared' && options.enabled === true && !options.reviewed) {
    throw new Error('--enabled requires --reviewed after checking identity and permitted use.');
  }
  const email = ['grant', 'revoke'].includes(command) ? normalizeEmail(args[0])
    : command === 'list' && args[0] ? normalizeEmail(args[0]) : null;
  if (email && !isValidEmail(email)) throw new Error('Invalid email address.');
  if ((command === 'shared' && options.enabled === true) || command === 'grant') {
    await checkProviderVoice(voiceId, command === 'shared');
  }
  const backend = await openBackend(options);
  try {
    const collection = backend.db.collection('voiceCatalog');
    if (command === 'shared') {
      const ref = collection.doc(`elevenlabs:${voiceId}`);
      const previous = await ref.get();
      const record = {
        ...(previous.data() ?? {}),
        provider: 'elevenlabs', voiceId, name: args[1],
        enabled: options.enabled ?? previous.data()?.enabled ?? false,
        ...(options.rank !== undefined ? { featuredRank: options.rank } : {}),
        ...(options.enabled === true ? {
          reviewedAt: Date.now(), reviewedBy: backend.actor, verifiedSynthesisAt: Date.now(),
        } : {}),
        updatedAt: Date.now(),
      };
      await ref.set(record);
      console.log(`${backend.targetLabel}: shared ${voiceId} (${record.enabled ? 'enabled' : 'disabled'})`);
    } else if (command === 'list' && !email) {
      const docs = (await collection.get()).docs;
      console.log(`${backend.targetLabel}: ${docs.length} shared voice records`);
      for (const doc of docs) console.log(`${doc.id} ${JSON.stringify(doc.data())}`);
    } else {
      const user = await backend.auth.getUserByEmail(email);
      const grants = backend.db.collection('users').doc(user.uid).collection('voiceGrants');
      if (command === 'grant') {
        await grants.doc(`elevenlabs:${voiceId}`).set({
          provider: 'elevenlabs', voiceId, name: args[2], enabled: true, updatedAt: Date.now(),
        });
        console.log(`${backend.targetLabel}: granted ${voiceId} to ${email}`);
      } else if (command === 'revoke') {
        await grants.doc(`elevenlabs:${voiceId}`).delete();
        console.log(`${backend.targetLabel}: revoked ${voiceId} from ${email}`);
      } else {
        const docs = (await grants.get()).docs;
        console.log(`${backend.targetLabel}: ${docs.length} voice grants for ${email}`);
        for (const doc of docs) console.log(`${doc.id} ${JSON.stringify(doc.data())}`);
      }
    }
  } finally {
    await backend.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
