import fs from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import { durationMsOf, sha256OfFile } from '../production/probe.js';
import { mimeTypeOf } from '../production/sources.js';
import type { DecisionBody, MessageBody, ProductionSummary, StudioClient, SuggestionBody, ThreadDetail, ThreadResource } from '../remote/client.js';
import {
  anchorPhrase,
  optionLabel,
  previewLabel,
  seconds,
  shortCutLabel,
  SUGGESTION_STATES,
  THREAD_STATUSES,
  timedLabel,
  type Suggestion,
  type SuggestionState,
  type ThreadStatus,
} from '../threads/index.js';
import { connectedClient, guarded, readSource } from './studio-support.js';

/**
 * `mdmedia comments …`: how an agent works the review comments on a
 * production's cuts in the connected studio. List what waits, read a
 * thread's context, claim it, reply (at a time on a video), suggest options
 * with previews, set states, add to the decision log, and say it's there.
 */

const AGENT_DEFAULT = process.env.MDMEDIA_AGENT ?? 'agent';

/** A production by id or slug. */
export async function resolveProduction(client: Pick<StudioClient, 'productions' | 'production'>, ref: string): Promise<ProductionSummary> {
  if (/^pr[0-9a-f]{24}$/.test(ref)) return client.production(ref);
  const { productions } = await client.productions();
  const found = productions.find((p) => p.slug === ref || p.id === ref);
  if (!found) throw new Error(`No production "${ref}". Pass its id or slug (see \`mdmedia comments list\` with a production).`);
  return found;
}

/** Names a cut the way the viewer does: "Take 5". */
export const cutLabeller = (production: Pick<ProductionSummary, 'cuts'>) => (cutId: string): string => {
  const label = production.cuts.find((cut) => cut.id === cutId)?.label;
  return label ? shortCutLabel(label) : cutId;
};

const firstLine = (text: string, max = 80): string => {
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One line per thread: id, where, status, the comment's start. */
export function describeList(threads: readonly ThreadResource[], production: Pick<ProductionSummary, 'cuts'>): string {
  if (threads.length === 0) return 'No threads.';
  const label = cutLabeller(production);
  return threads
    .map((t) => `${t.id}  ${label(t.version.cutId)} · ${seconds(t.anchor.time)}  ${t.statusLine.text}${t.needsAgent ? ' (needs an agent)' : ''}\n    ${firstLine(t.text)}`)
    .join('\n');
}

const who = (author: string): string => (author === 'owner' ? 'Owner' : `Agent ${author.replace(/^agent:/, '')}`);
const when = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** A whole thread as text, top to bottom, with every id an agent needs. */
export function describeThread(detail: ThreadDetail, production: Pick<ProductionSummary, 'cuts'>): string {
  const { thread, messages, suggestions } = detail;
  const label = cutLabeller(production);
  const byId = (id: string) => suggestions.find((s) => s.id === id);
  const out: string[] = [];
  out.push(`${thread.id} · ${label(thread.version.cutId)} · ${seconds(thread.anchor.time)} · ${anchorPhrase(null, thread.anchor.items, thread.anchor.time)}`);
  out.push(`Status: ${thread.status} — ${thread.statusLine.text}${thread.claim ? ` (claimed by ${thread.claim.agent} until ${when(thread.claim.expiresAt)})` : ''}`);
  out.push('', `${who(thread.author)}, ${when(thread.createdAt)}:`, thread.text);
  const option = (s: Suggestion) => {
    const lines = [`  ${s.id}  ${optionLabel(s)} · ${s.state}${s.appliedAs ? ` as ${label(s.appliedAs)}` : ''} — ${s.title}`];
    if (s.previews.length) lines.push(...s.previews.map((p) => `      preview ${p.assetId}: ${previewLabel(s, p.assetId)}`));
    return lines.join('\n');
  };
  const shown = new Set<string>();
  for (const m of messages) {
    const where = m.at ? ` · at ${timedLabel(m.at, label, byId)}` : '';
    const version = m.version ? ` · presents ${label(m.version.cutId)}` : '';
    out.push('', `${who(m.author)}, ${when(m.createdAt)}${where}${version} [${m.id}${m.replyTo ? `, replying to ${m.replyTo}` : ''}]:`, m.text);
    for (const id of m.suggestions ?? []) {
      const s = byId(id);
      if (s) { out.push(option(s)); shown.add(id); }
    }
  }
  const loose = suggestions.filter((s) => !shown.has(s.id));
  if (loose.length) out.push('', 'Options:', ...loose.map(option));
  return out.join('\n');
}

/** Uploads a preview file as production media (once per content hash) and returns its asset id. */
export async function uploadPreview(client: Pick<StudioClient, 'findProductionMedia' | 'uploadProductionMedia'>, file: string, open: (file: string) => Promise<Blob> = (f) => fs.openAsBlob(f)): Promise<string> {
  const mimeType = mimeTypeOf(file);
  if (!mimeType || !mimeType.startsWith('video/')) throw new Error(`A preview must be an .mp4, .mov or .webm video: ${file}`);
  const sha256 = await sha256OfFile(file);
  const found = (await client.findProductionMedia([sha256])).get(sha256);
  if (found) return found.id;
  const durationMs = await durationMsOf(file, mimeType);
  const asset = await client.uploadProductionMedia({
    sha256, mediaType: 'video', mimeType, byteLength: (await fs.promises.stat(file)).size, body: await open(file), ...(durationMs === undefined ? {} : { durationMs }),
  });
  return asset.id;
}

/** A suggestions file: `{ message?, round?, suggestions: [{ title, …, previews: [{ file | assetId, label? }] }] }`. */
export interface SuggestFile {
  message: string;
  round?: number;
  suggestions: Array<Omit<SuggestionBody, 'previews'> & { previews?: Array<{ file?: string; assetId?: string; label?: string }> }>;
}

/** Reads a suggestions file and uploads its previews; paths are relative to the file. */
export async function prepareSuggestions(client: Pick<StudioClient, 'findProductionMedia' | 'uploadProductionMedia'>, file: string, open?: (file: string) => Promise<Blob>): Promise<{ message: string; round?: number; suggestions: SuggestionBody[] }> {
  const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as SuggestFile;
  if (!parsed || !Array.isArray(parsed.suggestions) || parsed.suggestions.length === 0) throw new Error(`${file} needs "suggestions": a list of options.`);
  if (typeof parsed.message !== 'string' || !parsed.message.trim()) throw new Error(`${file} needs "message": what you read in the comment and which option you recommend.`);
  const dir = path.dirname(path.resolve(file));
  const suggestions: SuggestionBody[] = [];
  for (const s of parsed.suggestions) {
    const previews = [];
    for (const p of s.previews ?? []) {
      if (p.assetId) previews.push({ assetId: p.assetId, ...(p.label ? { label: p.label } : {}) });
      else if (p.file) previews.push({ assetId: await uploadPreview(client, path.resolve(dir, p.file), open), ...(p.label ? { label: p.label } : {}) });
      else throw new Error('Each preview needs "file" (a video to upload) or "assetId".');
    }
    suggestions.push({ ...s, previews });
  }
  return { message: parsed.message, ...(parsed.round ? { round: parsed.round } : {}), suggestions };
}

/**
 * Where a reply's time is: `--at 15.0` on the thread's cut, `--video take6`
 * for another cut, or `--preview <suggestion>[:<n>]` for an option's preview
 * (the first by default).
 */
export function timedRefFrom(args: { at?: string; video?: string; preview?: string }, detail: ThreadDetail): MessageBody['at'] {
  if (args.at === undefined) {
    if (args.video || args.preview) throw new Error('--video and --preview need --at <seconds>.');
    return undefined;
  }
  const time = Number(args.at);
  if (!args.at.trim() || !Number.isFinite(time) || time < 0) throw new Error(`--at must be seconds, 0 or more (got "${args.at}").`);
  if (args.preview) {
    const [id, n] = args.preview.split(':');
    const s = detail.suggestions.find((x) => x.id === id);
    if (!s) throw new Error(`No option "${id}" on this thread.`);
    const index = n === undefined ? 0 : Number(n) - 1;
    const preview = s.previews[index];
    if (!preview) throw new Error(`${optionLabel(s)} has no preview ${index + 1}.`);
    return { video: { kind: 'preview', suggestionId: s.id, assetId: preview.assetId }, time };
  }
  return { video: { kind: 'cut', cutId: args.video ?? detail.thread.version.cutId }, time };
}

const productionArg = { type: 'positional', required: true, description: 'The production: its id or slug' } as const;
const threadArg = { type: 'positional', required: true, description: 'The thread id' } as const;
const agentArg = { type: 'string', description: 'This agent\'s name, as it signs its messages (default MDMEDIA_AGENT, else "agent")' } as const;
const jsonArg = { type: 'boolean', description: 'Print JSON' } as const;
const print = (json: boolean | undefined, value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);

const list = defineCommand({
  meta: { name: 'list', description: 'List a production\'s threads with their status lines; --waiting for those an agent should pick up' },
  args: {
    production: productionArg,
    cut: { type: 'string', description: 'Only threads on this cut (e.g. take5)' },
    waiting: { type: 'boolean', description: 'Only threads that need an agent: open, or in progress with no live claim' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const threads = await client.threads(production.id, { ...(args.cut ? { cutId: args.cut } : {}), needsAgent: Boolean(args.waiting) });
      print(args.json, { threads }, describeList(threads, production));
    });
  },
});

const show = defineCommand({
  meta: { name: 'show', description: 'Print a thread: the comment, every message and option, with their ids' },
  args: { production: productionArg, thread: threadArg, json: jsonArg },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const detail = await client.thread(production.id, args.thread);
      print(args.json, detail, describeThread(detail, production));
    });
  },
});

const context = defineCommand({
  meta: { name: 'context', description: 'Print the thread\'s context bundle (JSON): the anchored items and their neighbours, words, decisions, versions, media, and what is missing' },
  args: { production: productionArg, thread: threadArg, output: { type: 'string', alias: 'o', description: 'Write it to this file instead' } },
  async run({ args }) {
    await guarded(false, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const bundle = await client.threadContext(production.id, args.thread);
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      if (args.output) {
        await fs.promises.writeFile(args.output, text);
        console.log(`${args.output}: ${bundle.missing.length} things missing`);
      } else process.stdout.write(text);
    });
  },
});

const claim = defineCommand({
  meta: { name: 'claim', description: 'Take a thread (Studio shows "Agent working") for --minutes; again to renew; --release to let go' },
  args: {
    production: productionArg,
    thread: threadArg,
    agent: agentArg,
    minutes: { type: 'string', description: 'How long the claim lasts (default 20, at most 120)' },
    release: { type: 'boolean', description: 'End the claim instead' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const minutes = args.minutes === undefined ? undefined : Number(args.minutes);
      if (minutes !== undefined && !(minutes > 0 && minutes <= 120)) throw new Error('--minutes must be more than 0 and at most 120.');
      const thread = args.release
        ? await client.releaseThread(production.id, args.thread)
        : await client.claimThread(production.id, args.thread, { agent: args.agent ?? AGENT_DEFAULT, ...(minutes ? { minutes } : {}) });
      print(args.json, thread, `${thread.id}: ${thread.statusLine.text}`);
    });
  },
});

const reply = defineCommand({
  meta: { name: 'reply', description: 'Reply on a thread, optionally at a time on a video (--at, with --video or --preview); ends your claim unless --keep-claim' },
  args: {
    production: productionArg,
    thread: threadArg,
    text: { type: 'string', alias: 't', description: 'The reply (or --input, or stdin)' },
    input: { type: 'string', alias: 'i', description: 'Read the reply from a file (- for stdin)' },
    at: { type: 'string', description: 'Seconds on the video the reply is about (the thread\'s cut unless --video or --preview)' },
    video: { type: 'string', description: 'A cut of the production the time is on, e.g. take6' },
    preview: { type: 'string', description: 'An option\'s preview the time is on: <suggestion id>[:<n>], the first preview by default' },
    'reply-to': { type: 'string', description: 'The message id it answers' },
    version: { type: 'string', description: 'A version (cut id) this message presents, such as the take an option was applied as' },
    'keep-claim': { type: 'boolean', description: 'Keep working: leave the thread claimed and its status as it is' },
    agent: agentArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const text = await readSource(args.input, args.text, { flag: '--text', what: 'the reply' });
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const detail = await client.thread(production.id, args.thread);
      const at = timedRefFrom(args, detail);
      const body: MessageBody = {
        text, agent: args.agent ?? AGENT_DEFAULT,
        ...(at ? { at } : {}),
        ...(args['reply-to'] ? { replyTo: args['reply-to'] } : {}),
        ...(args.version ? { version: { cutId: args.version } } : {}),
        ...(args['keep-claim'] ? { keepClaim: true } : {}),
      };
      const message = await client.postMessage(production.id, args.thread, body);
      const where = message.at ? ` at ${timedLabel(message.at, cutLabeller(production), (id) => detail.suggestions.find((s) => s.id === id))}` : '';
      print(args.json, message, `${message.id}: replied${where}`);
    });
  },
});

const suggest = defineCommand({
  meta: {
    name: 'suggest',
    description: 'Offer options on a thread from a JSON file ({ message, suggestions: [{ title, approach, steps, cost, risks, checks, previews: [{ file, label }], keeps, overturns, creates }] }); uploads the previews',
  },
  args: { production: productionArg, thread: threadArg, file: { type: 'string', alias: 'f', required: true, description: 'The suggestions file' }, agent: agentArg, json: jsonArg },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const prepared = await prepareSuggestions(client, args.file);
      const result = await client.postSuggestions(production.id, args.thread, { ...prepared, agent: args.agent ?? AGENT_DEFAULT });
      print(args.json, result, result.suggestions.map((s) => `${s.id}: ${optionLabel(s)} — ${s.title}${s.previews.length ? ` (${s.previews.length} preview${s.previews.length === 1 ? '' : 's'})` : ''}`).join('\n'));
    });
  },
});

const state = defineCommand({
  meta: {
    name: 'state',
    description: 'Set a thread\'s status (open, in-progress, addressed, resolved), or an option\'s state (proposed, accepted, rejected, applied --as <cut>)',
  },
  args: {
    production: productionArg,
    thread: threadArg,
    target: { type: 'positional', required: true, description: 'A thread status, or an option id followed by its state' },
    as: { type: 'string', description: 'For applied: the cut id of the version it became' },
    agent: agentArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      const extra = args._.slice(3);
      if (extra.length === 0) {
        if (!(THREAD_STATUSES as readonly string[]).includes(args.target)) throw new Error(`A thread's status is one of ${THREAD_STATUSES.join(', ')}; for an option, pass its id and then its state.`);
        const thread = await client.setThreadStatus(production.id, args.thread, args.target as ThreadStatus);
        print(args.json, thread, `${thread.id}: ${thread.statusLine.text}`);
        return;
      }
      const next = extra[0]!;
      if (!(SUGGESTION_STATES as readonly string[]).includes(next)) throw new Error(`An option's state is one of ${SUGGESTION_STATES.join(', ')}.`);
      if (next === 'applied' && !args.as) throw new Error('applied needs --as <cut id>: the version it became.');
      const s = await client.setSuggestionState(production.id, args.thread, args.target, { state: next as SuggestionState, ...(args.as ? { appliedAs: args.as } : {}), agent: args.agent ?? AGENT_DEFAULT });
      print(args.json, s, `${s.id}: ${optionLabel(s)} ${s.state}${s.appliedAs ? ` as ${cutLabeller(production)(s.appliedAs)}` : ''}`);
    });
  },
});

const decide = defineCommand({
  meta: { name: 'decide', description: 'Add a decision (or --kind constraint) to the production\'s log; --list prints the log' },
  args: {
    production: productionArg,
    text: { type: 'string', alias: 't', description: 'The decision' },
    list: { type: 'boolean', description: 'Print the decision log instead' },
    kind: { type: 'string', description: 'decision (default) or constraint' },
    take: { type: 'string', description: 'The version it came from or led to, as written, e.g. "Take 6 -> Take 7"' },
    source: { type: 'string', description: 'owner, owner direction, brief, or agent report' },
    quote: { type: 'string', description: 'The owner\'s words' },
    thread: { type: 'string', description: 'Thread ids it was decided in, comma-separated' },
    cut: { type: 'string', description: 'Cut ids it came from or led to, comma-separated' },
    id: { type: 'string', description: 'Its id (default: made up)' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const production = await resolveProduction(client, args.production);
      if (args.list) {
        const log = await client.decisions(production.id);
        print(args.json, log, [...log.decisions.map((d) => `${d.id}  ${d.take ? `[${d.take}] ` : ''}${d.text}`), ...log.constraints.map((c) => `${c.id}  (constraint) ${c.text}`)].join('\n') || 'No decisions yet.');
        return;
      }
      if (!args.text) throw new Error('Pass the decision as --text "…" (or --list to read the log).');
      const csv = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
      const body: DecisionBody = {
        text: args.text,
        ...(args.kind === 'constraint' ? { kind: 'constraint' } : {}),
        ...(args.take ? { take: args.take } : {}),
        ...(args.source ? { source: args.source as DecisionBody['source'] } : {}),
        ...(args.quote ? { quote: args.quote } : {}),
        ...(csv(args.thread) ? { threadIds: csv(args.thread) } : {}),
        ...(csv(args.cut) ? { cutIds: csv(args.cut) } : {}),
        ...(args.id ? { id: args.id } : {}),
      };
      const decision = await client.addDecision(production.id, body);
      print(args.json, decision, `${decision.id}: added`);
    });
  },
});

const heartbeat = defineCommand({
  meta: { name: 'heartbeat', description: 'Say this agent is watching for comments, so Studio doesn\'t show them as waiting; --every <s> keeps saying it' },
  args: {
    agent: agentArg,
    production: { type: 'string', description: 'Only this production (id or slug); all of them by default' },
    every: { type: 'string', description: 'Beat every this many seconds until stopped' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      const productionId = args.production ? (await resolveProduction(client, args.production)).id : undefined;
      const beat = async () => {
        const result = await client.commentHeartbeat({ agent: args.agent ?? AGENT_DEFAULT, ...(productionId ? { productionId } : {}) });
        print(args.json, result, `${result.agent}: watching ${result.productionId ?? 'all productions'} at ${when(result.seenAt)}`);
      };
      await beat();
      if (args.every === undefined) return;
      const seconds = Number(args.every);
      if (!(seconds >= 10)) throw new Error('--every must be at least 10 seconds.');
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        await beat();
      }
    });
  },
});

export const commentsCommand = defineCommand({
  meta: { name: 'comments', description: 'Work the review comments on a production\'s cuts in your studio, as an agent' },
  subCommands: { list, show, context, claim, reply, suggest, state, decide, heartbeat },
});
