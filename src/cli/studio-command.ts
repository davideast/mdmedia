import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defineCommand } from 'citty';
import {
  StudioApiError,
  StudioClient,
  type NarrationResource,
  type PlaylistDetail,
  type PlaylistPosition,
  type PlaylistSummary,
} from '../remote/client.js';
import {
  DEFAULT_STUDIO_URL,
  credentialsPath,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../remote/credentials.js';
import { NARRATE_SKILL, NARRATE_SKILL_NAME } from '../remote/skill.js';

function connectedClient(): StudioClient {
  const credentials = readCredentials();
  if (!credentials) throw new StudioApiError(401, 'not_logged_in', 'Not connected to a studio. Run `mdmedia studio login`.');
  return new StudioClient(credentials.url, credentials.apiKey);
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The URL is printed too.
  }
}

/** Errors print as one line; `--json` callers get `{ error: { code, message } }` on stdout. */
async function guarded(json: boolean | undefined, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = error instanceof StudioApiError ? error.code : 'error';
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ error: { code, message } }));
    else console.error(`mdmedia studio: ${message}`);
    process.exitCode = 1;
  }
}

function describe(narration: NarrationResource): string {
  if (narration.status === 'error') return `failed: ${narration.error?.message ?? 'unknown error'}`;
  if (narration.status === 'ready') return `ready (${Math.round(narration.durationMs / 1000)}s)`;
  return 'generating';
}

const login = defineCommand({
  meta: { name: 'login', description: 'Connect this machine to your studio. You approve it in the browser.' },
  args: {
    url: { type: 'string', description: `Studio address (default ${DEFAULT_STUDIO_URL})` },
    name: { type: 'string', description: 'What to call this connection in Settings' },
    open: { type: 'boolean', default: true, description: 'Open the approval page in your browser' },
  },
  async run({ args }) {
    await guarded(false, async () => {
      const url = args.url ?? readCredentials()?.url ?? DEFAULT_STUDIO_URL;
      const client = new StudioClient(url);
      const name = args.name ?? `mdmedia CLI on ${os.hostname()}`;
      const started = await client.startDevice(name);
      console.log(`To connect "${name}", approve code ${started.userCode} at:\n  ${started.verificationUriComplete}\n`);
      if (args.open) openInBrowser(started.verificationUriComplete);
      const deadline = Date.now() + started.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, started.interval * 1000));
        const poll = await client.pollDevice(started.deviceCode);
        if (poll.status === 'pending') continue;
        if (poll.status === 'approved') {
          writeCredentials({ url: client.origin, apiKey: poll.apiKey, keyId: poll.key.id, name: poll.key.name, createdAt: Date.now() });
          console.log(`Connected to ${client.origin}. Key saved to ${credentialsPath()} (readable only by you).`);
          return;
        }
        throw new Error(poll.status === 'denied' ? 'The connection was denied in the browser.' : 'The code expired. Run login again.');
      }
      throw new Error('The code expired before it was approved. Run login again.');
    });
  },
});

const logout = defineCommand({
  meta: { name: 'logout', description: 'Revoke this machine\'s key and forget it' },
  async run() {
    await guarded(false, async () => {
      if (process.env.MDMEDIA_API_KEY) throw new Error('MDMEDIA_API_KEY is set in the environment; revoke that key in Settings.');
      const credentials = readCredentials();
      if (!credentials) { console.log('Not connected.'); return; }
      try {
        await new StudioClient(credentials.url, credentials.apiKey).revokeSelf();
      } catch (error) {
        // An already-revoked key is a successful logout; anything else is reported, and the file still goes.
        if (!(error instanceof StudioApiError && error.status === 401)) console.error(`mdmedia studio: could not revoke the key (${(error as Error).message}). Revoke it in Settings.`);
      }
      deleteCredentials();
      console.log('Disconnected.');
    });
  },
});

const options = defineCommand({
  meta: { name: 'options', description: 'List voices, models, presets, and your defaults' },
  args: { json: { type: 'boolean', description: 'Print JSON' } },
  async run({ args }) {
    await guarded(args.json, async () => {
      const result = await connectedClient().options() as {
        voices: { gemini: { name: string }[]; elevenlabs: { id: string; name: string }[] };
        models: string[];
        presets: { delivery: { name: string }[]; instructions: { name: string }[] };
        defaults: Record<string, unknown>;
      };
      if (args.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`Gemini voices: ${result.voices.gemini.map((voice) => voice.name).join(', ')}`);
      if (result.voices.elevenlabs.length) console.log(`ElevenLabs voices: ${result.voices.elevenlabs.map((voice) => `${voice.name} (${voice.id})`).join(', ')}`);
      console.log(`Models: ${result.models.join(', ')}`);
      console.log(`Delivery presets: ${result.presets.delivery.map((preset) => preset.name).join(', ')}`);
      console.log(`Instruction presets: ${result.presets.instructions.map((preset) => preset.name).join(', ')}`);
      console.log(`Defaults: ${JSON.stringify(result.defaults)}`);
    });
  },
});

async function readInput(input: string | undefined, text: string | undefined): Promise<string> {
  if (text !== undefined && input !== undefined) throw new Error('Pass either --input or --text, not both.');
  if (text !== undefined) return text;
  if (input === '-' || (input === undefined && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (input === undefined) throw new Error('Pass --input <file>, --text "…", or pipe markdown on stdin.');
  return fs.promises.readFile(input, 'utf8');
}

type PositionArgs = { start?: boolean; end?: boolean; before?: string; after?: string };

/** `--start`, `--end`, `--before <id>`, or `--after <id>`; at most one. */
function positionFrom(args: PositionArgs, fallback: PlaylistPosition | null): PlaylistPosition | undefined {
  const given = [args.start && 'start', args.end && 'end', args.before && 'before', args.after && 'after'].filter(Boolean);
  if (given.length > 1) throw new Error('Pass only one of --start, --end, --before, --after.');
  if (args.start) return 'start';
  if (args.end) return 'end';
  if (args.before) return { before: args.before };
  if (args.after) return { after: args.after };
  return fallback ?? undefined;
}

function placementNote(playlist: { id: string; title: string; position: number } | { error: { message: string } } | undefined): string {
  if (!playlist) return '';
  if ('error' in playlist) return `\nNot added to the playlist: ${playlist.error.message}`;
  return `\nAdded to "${playlist.title}" at position ${playlist.position}.`;
}

const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);

function playlistLine(playlist: PlaylistSummary): string {
  const pending = playlist.counts.streaming ? `, ${playlist.counts.streaming} generating` : '';
  const failed = playlist.counts.error ? `, ${playlist.counts.error} failed` : '';
  return `${playlist.id}  ${playlist.title} — ${playlist.itemCount} items, ${minutes(playlist.durationMs)}${pending}${failed}`;
}

function printPlaylist(playlist: PlaylistDetail, json: boolean | undefined): void {
  if (json) { console.log(JSON.stringify(playlist, null, 2)); return; }
  console.log(playlistLine(playlist));
  if (playlist.description) console.log(playlist.description);
  playlist.items.forEach((item, index) => {
    const state = item.status === 'ready' ? minutes(item.durationMs) : item.status;
    console.log(`${String(index + 1).padStart(3)}. ${item.id}  ${item.title || '(untitled)'} — ${state}`);
  });
  if (playlist.unchanged?.length) console.log(`Unchanged (already there, or not there to remove): ${playlist.unchanged.join(', ')}`);
}

const narrate = defineCommand({
  meta: { name: 'narrate', description: 'Create a private narration in your studio' },
  args: {
    input: { type: 'string', alias: 'i', description: 'Markdown file to narrate (- for stdin)' },
    text: { type: 'string', alias: 't', description: 'Markdown text to narrate' },
    voice: { type: 'string', alias: 'v', description: 'Gemini voice name or ElevenLabs voice id' },
    model: { type: 'string', alias: 'm', description: 'Gemini TTS model' },
    delivery: { type: 'string', description: 'How the reader should sound' },
    deliveryPreset: { type: 'string', description: 'Delivery preset name' },
    speed: { type: 'string', description: 'Pace, 0.5 to 2.5' },
    rewrite: { type: 'boolean', description: 'Rewrite for the ear (--no-rewrite to read as written)' },
    instructions: { type: 'string', description: 'Rewrite instructions' },
    instructionsPreset: { type: 'string', description: 'Rewrite instructions preset name' },
    structure: { type: 'boolean', description: 'Clean document structure' },
    verbalizeDiagrams: { type: 'boolean', description: 'Describe diagrams aloud' },
    id: { type: 'string', description: 'Your own narration id, so a retry cannot create a duplicate' },
    playlist: { type: 'string', alias: 'p', description: 'Add it to this playlist (id or exact title) as soon as it starts' },
    createPlaylist: { type: 'boolean', description: 'Create --playlist if no playlist has that title' },
    start: { type: 'boolean', description: 'Put it at the start of --playlist (default: the end)' },
    before: { type: 'string', description: 'Put it before this narration id in --playlist' },
    after: { type: 'string', description: 'Put it after this narration id in --playlist' },
    wait: { type: 'boolean', description: 'Wait until the narration is ready' },
    output: { type: 'string', alias: 'o', description: 'Save the finished audio here (implies --wait)' },
    timeout: { type: 'string', description: 'Seconds to wait (default 900)' },
    json: { type: 'boolean', description: 'Print JSON' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const markdown = await readInput(args.input, args.text);
      const body: Record<string, unknown> = { markdown };
      const set = (key: string, value: unknown) => { if (value !== undefined) body[key] = value; };
      set('voice', args.voice);
      set('model', args.model);
      set('delivery', args.delivery);
      set('deliveryPreset', args.deliveryPreset);
      set('speed', args.speed === undefined ? undefined : Number(args.speed));
      set('rewriteForNarration', args.rewrite);
      set('instructions', args.instructions);
      set('instructionsPreset', args.instructionsPreset);
      set('structureMarkdown', args.structure);
      set('verbalizeDiagrams', args.verbalizeDiagrams);
      set('id', args.id);
      set('playlist', args.playlist);
      set('playlistPosition', positionFrom(args, null));
      if (args.createPlaylist) body.createPlaylist = true;

      const created = await client.createNarration(body);
      if (!args.wait && !args.output) {
        if (args.json) console.log(JSON.stringify(created, null, 2));
        else console.log(`Narration started: ${created.links.web}${placementNote(created.playlist)}`);
        return;
      }
      if (!args.json) console.error(`Generating ${created.links.web} …${placementNote(created.playlist)}`);
      const finished = await client.waitForNarration(created.id, { timeoutMs: Number(args.timeout ?? 900) * 1000 });
      let saved: string | undefined;
      if (args.output && finished.status === 'ready') {
        saved = path.resolve(args.output);
        await fs.promises.writeFile(saved, await client.audio(created.id));
      }
      if (args.json) console.log(JSON.stringify({ ...finished, ...(created.playlist ? { playlist: created.playlist } : {}), ...(saved ? { savedTo: saved } : {}) }, null, 2));
      else console.log(`${finished.title || created.id}: ${describe(finished)} — ${finished.links.web}${saved ? `\nSaved ${saved}` : ''}`);
      if (finished.status === 'error') process.exitCode = 1;
    });
  },
});

const status = defineCommand({
  meta: { name: 'status', description: 'Show a narration\'s progress' },
  args: {
    id: { type: 'positional', required: true, description: 'Narration id' },
    json: { type: 'boolean', description: 'Print JSON' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const narration = await connectedClient().narration(args.id);
      if (args.json) console.log(JSON.stringify(narration, null, 2));
      else console.log(`${narration.title || narration.id}: ${describe(narration)} — ${narration.links.web}`);
    });
  },
});

const narrations = defineCommand({
  meta: { name: 'narrations', description: 'List your narrations, newest first' },
  args: {
    q: { type: 'string', description: 'Only titles containing this text' },
    status: { type: 'string', description: 'ready, streaming, or error' },
    limit: { type: 'string', description: 'How many (default 50)' },
    json: { type: 'boolean', description: 'Print JSON' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const result = await connectedClient().narrations({ q: args.q, status: args.status, limit: args.limit === undefined ? undefined : Number(args.limit) });
      if (args.json) { console.log(JSON.stringify(result, null, 2)); return; }
      for (const narration of result.narrations) console.log(`${narration.id}  ${narration.title || '(untitled)'} — ${describe(narration)}`);
    });
  },
});

const playlistArg = { type: 'positional', required: true, description: 'Playlist id or exact title' } as const;
const jsonArg = { type: 'boolean', description: 'Print JSON' } as const;
const positionArgs = {
  start: { type: 'boolean', description: 'At the start' },
  end: { type: 'boolean', description: 'At the end (default)' },
  before: { type: 'string', description: 'Before this narration id' },
  after: { type: 'string', description: 'After this narration id' },
} as const;

/** Narration ids after the playlist positional. */
function idsAfterPlaylist(rest: string[]): string[] {
  const ids = rest.slice(1);
  if (ids.length === 0) throw new Error('Name at least one narration id.');
  return ids;
}

/** Runs `edit` against the playlist named by id or title, then prints the result. */
function playlistAction(json: boolean | undefined, idOrTitle: string, edit: (client: StudioClient, id: string) => Promise<PlaylistDetail>) {
  return guarded(json, async () => {
    const client = connectedClient();
    const { id } = await client.resolvePlaylist(idOrTitle);
    printPlaylist(await edit(client, id), json);
  });
}

const playlistList = defineCommand({
  meta: { name: 'list', description: 'Your playlists, most recently changed first' },
  args: { json: jsonArg },
  async run({ args }) {
    await guarded(args.json, async () => {
      const { playlists } = await connectedClient().playlists();
      if (args.json) console.log(JSON.stringify({ playlists }, null, 2));
      else if (playlists.length === 0) console.log('No playlists yet.');
      else for (const playlist of playlists) console.log(playlistLine(playlist));
    });
  },
});

const playlistShow = defineCommand({
  meta: { name: 'show', description: 'A playlist and its items in order' },
  args: { playlist: playlistArg, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => client.playlist(id)),
});

const playlistCreate = defineCommand({
  meta: { name: 'create', description: 'Create a playlist, optionally with narrations in it' },
  args: {
    title: { type: 'positional', required: true, description: 'Title' },
    description: { type: 'string', description: 'Description' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const narrationIds = args._.slice(1);
      printPlaylist(await connectedClient().createPlaylist({
        title: args.title,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(narrationIds.length ? { narrationIds } : {}),
      }), args.json);
    });
  },
});

const playlistAdd = defineCommand({
  meta: { name: 'add', description: 'Add narrations: add <playlist> <id…> [--start | --before <id> | --after <id>]' },
  args: { playlist: playlistArg, ...positionArgs, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => {
    const at = positionFrom(args, null);
    return client.editPlaylist(id, [{ add: idsAfterPlaylist(args._), ...(at ? { at } : {}) }]);
  }),
});

const playlistRemove = defineCommand({
  meta: { name: 'remove', description: 'Remove narrations: remove <playlist> <id…>' },
  args: { playlist: playlistArg, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => client.editPlaylist(id, [{ remove: idsAfterPlaylist(args._) }])),
});

const playlistMove = defineCommand({
  meta: { name: 'move', description: 'Move one narration: move <playlist> <id> --start | --end | --before <id> | --after <id>' },
  args: { playlist: playlistArg, ...positionArgs, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => {
    const [narrationId, ...extra] = idsAfterPlaylist(args._);
    if (extra.length) throw new Error('move takes one narration id.');
    const to = positionFrom(args, null);
    if (!to) throw new Error('Say where: --start, --end, --before <id>, or --after <id>.');
    return client.editPlaylist(id, [{ move: narrationId!, to }]);
  }),
});

const playlistOrder = defineCommand({
  meta: { name: 'order', description: 'Set the full order: order <playlist> <id…> (exactly the items already there)' },
  args: { playlist: playlistArg, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => client.reorderPlaylist(id, idsAfterPlaylist(args._))),
});

const playlistRename = defineCommand({
  meta: { name: 'rename', description: 'Rename: rename <playlist> <new title>' },
  args: { playlist: playlistArg, title: { type: 'positional', required: true, description: 'New title' }, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => client.updatePlaylist(id, { title: args.title })),
});

const playlistDescribe = defineCommand({
  meta: { name: 'describe', description: 'Set the description: describe <playlist> <text>' },
  args: { playlist: playlistArg, text: { type: 'positional', required: true, description: 'Description' }, json: jsonArg },
  run: ({ args }) => playlistAction(args.json, args.playlist, (client, id) => client.updatePlaylist(id, { description: args.text })),
});

const playlistDelete = defineCommand({
  meta: { name: 'delete', description: 'Delete a playlist. Its narrations are kept.' },
  args: { playlist: playlistArg, json: jsonArg },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const playlist = await client.resolvePlaylist(args.playlist);
      await client.deletePlaylist(playlist.id);
      if (args.json) console.log(JSON.stringify({ deleted: playlist.id }));
      else console.log(`Deleted "${playlist.title}". Its narrations are still in your library.`);
    });
  },
});

const playlist = defineCommand({
  meta: { name: 'playlist', description: 'Create and arrange playlists' },
  subCommands: {
    list: playlistList,
    show: playlistShow,
    create: playlistCreate,
    add: playlistAdd,
    remove: playlistRemove,
    move: playlistMove,
    order: playlistOrder,
    rename: playlistRename,
    describe: playlistDescribe,
    delete: playlistDelete,
  },
});

const installSkill = defineCommand({
  meta: { name: 'install-skill', description: 'Teach coding agents to narrate through your studio when you ask' },
  args: {
    dir: { type: 'string', description: 'Skills directory (default ~/.claude/skills)' },
    print: { type: 'boolean', description: 'Print the instructions instead, e.g. to paste into AGENTS.md' },
  },
  async run({ args }) {
    if (args.print) { process.stdout.write(NARRATE_SKILL); return; }
    const dir = path.join(args.dir ?? path.join(os.homedir(), '.claude', 'skills'), NARRATE_SKILL_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), NARRATE_SKILL);
    console.log(`Installed ${path.join(dir, 'SKILL.md')}. Agents will narrate through your studio when you ask.`);
  },
});

export const studioCommand = defineCommand({
  meta: { name: 'studio', description: 'Create narrations in your mdmedia studio from the terminal or a coding agent' },
  subCommands: { login, logout, options, narrate, status, narrations, playlist, 'install-skill': installSkill },
});
