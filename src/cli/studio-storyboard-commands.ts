import { defineCommand, type ArgsDef, type CommandDef } from 'citty';
import {
  StudioApiError,
  type StudioClient,
  type StoryBeat,
  type StoryboardDocument,
  type StoryboardResource,
} from '../remote/client.js';
import { connectedClient, guarded, readSource } from './studio-support.js';
/** Reject misspelled options before any read or generation, including --dryrun. */
function storyboardAction<T extends ArgsDef>(
  definition: CommandDef<T> & {
    args: T;
    run: NonNullable<CommandDef<T>['run']>;
  },
) {
  const known = new Set([
    '_',
    ...Object.keys(definition.args).flatMap((key) => [
      key,
      key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    ]),
  ]);
  return defineCommand({
    ...definition,
    async run(context) {
      await guarded(context.args.json === true, async () => {
        const unknown = Object.keys(context.args).find(
          (key) => !known.has(key),
        );
        if (unknown)
          throw new StudioApiError(
            400,
            'unknown_option',
            `Unknown option --${unknown}. Check this command's --help.`,
          );
        await definition.run(context);
      });
    },
  });
}
const json = { type: 'boolean', description: 'Print JSON' } as const;
const id = {
  type: 'positional',
  required: true,
  description: 'Storyboard id',
} as const;
const input = {
  type: 'string',
  description: 'JSON file (- for stdin)',
} as const;
function print(board: StoryboardResource, json?: boolean) {
  if (json) {
    console.log(JSON.stringify(board, null, 2));
    return;
  }
  console.log(
    `${board.id}  ${board.title} (revision ${board.storyboard?.revision ?? 0})`,
  );
  for (const [index, beat] of (
    board.storyboard?.document.beats ?? []
  ).entries())
    console.log(`${index + 1}. ${beat.id}  ${beat.title}`);
}
const list = storyboardAction({
  meta: { name: 'list', description: 'List your independent storyboards' },
  args: { json },
  async run({ args }) {
    await guarded(args.json, async () => {
      const result = await connectedClient().listStoryboards();
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else
        for (const board of result.storyboards)
          console.log(`${board.id}  ${board.title} — ${board.beatCount} beats`);
    });
  },
});
const show = storyboardAction({
  meta: { name: 'show', description: 'Read a storyboard and its revision' },
  args: { id, json },
  async run({ args }) {
    await guarded(args.json, async () =>
      print(await connectedClient().getStoryboard(args.id), args.json),
    );
  },
});
const create = storyboardAction({
  meta: { name: 'create', description: 'Create an independent storyboard' },
  args: {
    title: { type: 'string', required: true, description: 'Storyboard title' },
    input,
    json,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const document =
        args.input === undefined
          ? undefined
          : ((await readObject(args.input)) as unknown as StoryboardDocument);
      print(
        await connectedClient().createStoryboard({
          title: args.title,
          ...(document === undefined ? {} : { document }),
        }),
        args.json,
      );
    });
  },
});
const revision = {
  type: 'string',
  description: 'Required saved revision; stale edits are rejected',
} as const;
function expectedRevision(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error(
      'Pass --revision with the saved positive integer revision from show.',
    );
  return Number(raw);
}
async function current(
  client: StudioClient,
  id: string,
  revision: number,
): Promise<StoryboardResource> {
  const board = await client.getStoryboard(id);
  if (board.storyboard?.revision !== revision)
    throw new StudioApiError(
      409,
      'storyboard_conflict',
      'This storyboard changed. Run show, reconcile your edits, and use its revision. Nothing was saved.',
    );
  return board;
}
const update = storyboardAction({
  meta: {
    name: 'update',
    description: 'Save a title or document with a revision check',
  },
  args: {
    id,
    revision,
    title: { type: 'string', description: 'New title' },
    input,
    json,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const expected = expectedRevision(args.revision);
      if (args.title === undefined && args.input === undefined)
        throw new Error('Pass --title or --input to update.');
      const document =
        args.input === undefined
          ? undefined
          : ((await readObject(args.input)) as unknown as StoryboardDocument);
      const client = connectedClient();
      const board = await current(client, args.id, expected);
      print(
        await client.updateStoryboard(args.id, {
          expectedRevision: expected,
          document:
            document === undefined ? board.storyboard!.document : document,
          ...(args.title === undefined ? {} : { title: args.title }),
        }),
        args.json,
      );
    });
  },
});
const beatId = {
  type: 'positional',
  required: true,
  description: 'Stable beat id',
} as const;
async function readObject(
  file: string | undefined,
): Promise<Record<string, unknown>> {
  if (file === undefined)
    throw new Error('Pass --input <file.json> or --input - for stdin.');
  const value: unknown = JSON.parse(
    await readSource(file, undefined, { flag: '--input', what: 'JSON' }),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Input must be a JSON object.');
  return value as Record<string, unknown>;
}
const addBeat = storyboardAction({
  meta: {
    name: 'add',
    description: 'Add a beat, optionally before another beat',
  },
  args: {
    id,
    revision,
    input,
    before: { type: 'string', description: 'Insert before this beat id' },
    json,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const expected = expectedRevision(args.revision);
      const beat = await readObject(args.input);
      const client = connectedClient();
      const board = await current(client, args.id, expected);
      const doc = board.storyboard!.document;
      const at =
        args.before === undefined
          ? doc.beats.length
          : doc.beats.findIndex((b) => b.id === args.before);
      if (at < 0) throw new Error(`No beat with id "${args.before}".`);
      const beats = [...doc.beats];
      beats.splice(at, 0, beat as unknown as StoryBeat);
      print(
        await client.updateStoryboard(args.id, {
          expectedRevision: expected,
          document: { ...doc, beats },
        }),
        args.json,
      );
    });
  },
});
const updateBeat = storyboardAction({
  meta: {
    name: 'update',
    description: 'Patch a beat without changing its identity',
  },
  args: { id, beatId, revision, input, json },
  async run({ args }) {
    await guarded(args.json, async () => {
      const expected = expectedRevision(args.revision);
      const patch = await readObject(args.input);
      const fields = [
        'title',
        'purpose',
        'summary',
        'script',
        'visual',
        'image',
        'notes',
        'status',
        'estimatedSeconds',
      ];
      if (
        !Object.keys(patch).length ||
        Object.keys(patch).some((key) => !fields.includes(key))
      )
        throw new Error('Provide supported beat fields; id cannot be changed.');
      const client = connectedClient();
      const board = await current(client, args.id, expected);
      const doc = board.storyboard!.document;
      if (!doc.beats.some((beat) => beat.id === args.beatId))
        throw new Error(`No beat with id "${args.beatId}".`);
      const beats = doc.beats.map((beat) =>
        beat.id === args.beatId ? { ...beat, ...patch } : beat,
      );
      print(
        await client.updateStoryboard(args.id, {
          expectedRevision: expected,
          document: { ...doc, beats },
        }),
        args.json,
      );
    });
  },
});
const yes = { type: 'boolean', description: 'Confirm deletion' } as const;
const moveBeat = storyboardAction({
  meta: {
    name: 'move',
    description: 'Move a beat before or after another beat',
  },
  args: {
    id,
    beatId,
    revision,
    before: { type: 'string', description: 'Destination beat id' },
    after: { type: 'string', description: 'Destination beat id' },
    json,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const expected = expectedRevision(args.revision);
      if ((args.before === undefined) === (args.after === undefined))
        throw new Error('Pass exactly one of --before or --after.');
      const target = args.before ?? args.after!;
      if (target === args.beatId)
        throw new Error('A beat cannot be moved relative to itself.');
      const client = connectedClient();
      const board = await current(client, args.id, expected);
      const doc = board.storyboard!.document;
      const moving = doc.beats.find((beat) => beat.id === args.beatId);
      if (!moving) throw new Error(`No beat with id "${args.beatId}".`);
      const beats = doc.beats.filter((beat) => beat.id !== args.beatId);
      const at = beats.findIndex((beat) => beat.id === target);
      if (at < 0) throw new Error(`No beat with id "${target}".`);
      beats.splice(at + (args.after === undefined ? 0 : 1), 0, moving);
      print(
        await client.updateStoryboard(args.id, {
          expectedRevision: expected,
          document: { ...doc, beats },
        }),
        args.json,
      );
    });
  },
});
const removeBeat = storyboardAction({
  meta: {
    name: 'remove',
    description: 'Remove one beat with an explicit confirmation',
  },
  args: { id, beatId, revision, yes, json },
  async run({ args }) {
    await guarded(args.json, async () => {
      const expected = expectedRevision(args.revision);
      if (!args.yes) throw new Error('Pass --yes to remove this beat.');
      const client = connectedClient();
      const board = await current(client, args.id, expected);
      const doc = board.storyboard!.document;
      if (!doc.beats.some((beat) => beat.id === args.beatId))
        throw new Error(`No beat with id "${args.beatId}".`);
      print(
        await client.updateStoryboard(args.id, {
          expectedRevision: expected,
          document: {
            ...doc,
            beats: doc.beats.filter((beat) => beat.id !== args.beatId),
          },
        }),
        args.json,
      );
    });
  },
});
const deleteBoard = storyboardAction({
  meta: { name: 'delete', description: 'Delete an independent storyboard' },
  args: { id, yes, json },
  async run({ args }) {
    await guarded(args.json, async () => {
      if (!args.yes) throw new Error('Pass --yes to delete this storyboard.');
      await connectedClient().deleteStoryboard(args.id);
      console.log(
        args.json
          ? JSON.stringify({ id: args.id, deleted: true })
          : `Deleted storyboard ${args.id}.`,
      );
    });
  },
});
interface ReaderOptions {
  voices: {
    gemini: {
      id: string;
      name: string;
    }[];
    elevenlabs: {
      id: string;
      name: string;
    }[];
  };
  models: string[];
  presets: {
    delivery: {
      id: string;
      name: string;
      text: string;
    }[];
  };
  defaults: {
    voice: {
      provider: 'gemini' | 'elevenlabs';
      id: string;
      name: string;
    };
    model: string;
    delivery: string;
    speed: number;
  };
}
const narrate = storyboardAction({
  meta: {
    name: 'narrate',
    description: 'Read saved script or walkthrough using the Studio reader',
  },
  args: {
    id,
    json,
    beat: { type: 'string', description: 'Read only this beat id' },
    view: {
      type: 'string',
      default: 'script',
      description: 'script or board (walkthrough)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview exact narration request without generating audio',
    },
    voice: {
      type: 'string',
      description: 'Gemini voice name or authorized ElevenLabs voice id',
    },
    delivery: { type: 'string', description: 'How the reader should sound' },
    deliveryPreset: {
      type: 'string',
      description: 'Saved delivery preset name or id',
    },
    wait: { type: 'boolean', description: 'Wait for the recording to finish' },
    timeout: { type: 'string', description: 'Seconds to wait (default 900)' },
    model: { type: 'string', description: 'Gemini TTS model' },
    speed: { type: 'string', description: 'Pace, 0.5 to 2.5' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      if (args.view !== 'script' && args.view !== 'board')
        throw new Error('--view must be script or board.');
      if (args.delivery !== undefined && args.deliveryPreset !== undefined)
        throw new Error(
          'Pass either --delivery or --deliveryPreset, not both.',
        );
      const timeout = Number(args.timeout ?? 900);
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error('--timeout must be a positive number of seconds.');
      const speed = args.speed === undefined ? undefined : Number(args.speed);
      if (
        speed !== undefined &&
        (!Number.isFinite(speed) || speed < 0.5 || speed > 2.5)
      )
        throw new Error('--speed must be between 0.5 and 2.5.');
      const client = connectedClient();
      const board = await client.getStoryboard(args.id);
      const beats = board.storyboard?.document.beats ?? [];
      if (
        args.beat !== undefined &&
        !beats.some((beat) => beat.id === args.beat)
      )
        throw new Error(`No beat with id "${args.beat}".`);
      const segments = beats
        .filter((beat) => args.beat === undefined || beat.id === args.beat)
        .map((beat) => ({
          id: beat.id,
          text: (args.view === 'script'
            ? beat.script
            : beat.summary || beat.script
          ).trim(),
        }))
        .filter((segment) => segment.text);
      if (!segments.length)
        throw new Error(
          'There is no authored text to narrate in this selection.',
        );
      const options = (await client.options()) as unknown as ReaderOptions;
      let voice = options.defaults.voice;
      if (args.voice !== undefined) {
        const gemini = options.voices.gemini.find(
          (voice) =>
            voice.name.toLowerCase() === args.voice!.trim().toLowerCase(),
        );
        const elevenlabs = options.voices.elevenlabs.find(
          (voice) => voice.id === args.voice,
        );
        if (!gemini && !elevenlabs)
          throw new Error(
            'Unknown reader. Use mdmedia studio options to see available voices.',
          );
        voice = gemini
          ? { ...gemini, provider: 'gemini' }
          : { ...elevenlabs!, provider: 'elevenlabs' };
      }
      if (args.model !== undefined && !options.models.includes(args.model))
        throw new Error('Unknown TTS model. Use mdmedia studio options.');
      let delivery = args.delivery ?? options.defaults.delivery;
      if (args.deliveryPreset !== undefined) {
        const wanted = args.deliveryPreset.toLowerCase();
        const preset = options.presets.delivery.find(
          (p) =>
            p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted,
        );
        if (!preset)
          throw new Error(`No delivery preset named "${args.deliveryPreset}".`);
        delivery = preset.text;
      }
      const request = {
        markdown: segments.map((segment) => segment.text).join('\n\n'),
        voice: voice.name,
        voiceProvider: voice.provider,
        voiceId: voice.id,
        model: args.model ?? options.defaults.model,
        promptStyle: delivery,
        speed: speed ?? options.defaults.speed,
      };
      if (args['dry-run']) {
        console.log(
          JSON.stringify(
            {
              storyboardId: args.id,
              view: args.view,
              beatIds: segments.map((segment) => segment.id),
              request,
            },
            null,
            2,
          ),
        );
        return;
      }
      const created = await client.narrateStoryboard(args.id, request);
      const result = {
        id: created.id,
        links: {
          web: `${client.origin}/narration/${encodeURIComponent(created.id)}`,
        },
      };
      if (args.wait) {
        try {
          const finished = await client.waitForNarration(created.id, {
            timeoutMs: timeout * 1000,
          });
          if (finished.status !== 'ready') {
            if (args.json)
              console.log(
                JSON.stringify(
                  {
                    ...result,
                    status: finished.status,
                    error: finished.error ?? {
                      code: 'not_ready',
                      message:
                        'Recording is still running. Check studio status; do not generate again.',
                    },
                  },
                  null,
                  2,
                ),
              );
            else
              console.error(
                `Narration ${created.id}: ${finished.error?.message ?? 'still running'}. Check mdmedia studio status ${created.id}.`,
              );
            process.exitCode = 1;
            return;
          }
          console.log(
            args.json
              ? JSON.stringify(
                  {
                    ...result,
                    status: finished.status,
                    durationMs: finished.durationMs,
                  },
                  null,
                  2,
                )
              : `Narration ready: ${result.links.web}`,
          );
          return;
        } catch (error) {
          throw new Error(
            `Narration ${created.id} was submitted and may still finish. Check mdmedia studio status ${created.id}. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      console.log(
        args.json
          ? JSON.stringify(result, null, 2)
          : `Narration: ${result.links.web}`,
      );
    });
  },
});
const beat = defineCommand({
  meta: { name: 'beat', description: 'Edit and arrange beats by stable id' },
  subCommands: {
    add: addBeat,
    update: updateBeat,
    move: moveBeat,
    remove: removeBeat,
  },
});
export const storyboardCommand = defineCommand({
  meta: {
    name: 'storyboard',
    description: 'Plan independent storyboards in Studio',
  },
  subCommands: {
    list,
    show,
    create,
    update,
    delete: deleteBoard,
    beat,
    narrate,
  },
});
