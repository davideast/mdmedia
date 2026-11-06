import { defineCommand } from 'citty';
import { AGENTIC_ANALYSIS_MODELS, MEDIA_RESOLUTIONS, isYouTubeUrl, parseVideoTime } from '../analysis/index.js';
import type { AnalysisRequestBody } from '../remote/client.js';
import { readResponseSchema } from './analyze-command.js';
import { checkPrompt, checkVideoReference, numberIn, oneOf, readPrompt, runMediaCommand } from './studio-media-commands.js';
import { connectedClient, guarded } from './studio-support.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const INTERACTION_ID = /^[A-Za-z0-9_\-/.]{1,256}$/;
/** Matches the studio's cap on `responseSchema`. */
const MAX_RESPONSE_SCHEMA_CHARS = 32_000;

export interface StudioAnalyzeArgs {
  video?: string;
  fromVideo?: string;
  generation?: string;
  clip?: string;
  item?: string;
  model?: string;
  processing?: string;
  start?: string;
  end?: string;
  fps?: string;
  mediaResolution?: string;
  system?: string;
  schema?: string;
  followUp?: string;
  narrate?: boolean;
  narrateVoice?: string;
  narratePlaylist?: string;
}

/**
 * The request body from flags, plus the local video to upload first, if any. Everything is
 * checked here, before any upload or create. The studio resolves anything left out: its default
 * model, and on `--item` the analysis's previous settings and source.
 */
export async function studioAnalysisBody(prompt: string, args: StudioAnalyzeArgs): Promise<{ body: AnalysisRequestBody; upload?: string }> {
  const body: AnalysisRequestBody = { prompt: checkPrompt(prompt, 32_000) };
  let upload: string | undefined;
  const id = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!ID.test(value.trim())) throw new Error(`${flag} must be an id.`);
    return value.trim();
  };
  const item = id('--item', args.item);
  const fromVideo = id('--from-video', args.fromVideo);
  const generation = id('--generation', args.generation);
  const clip = numberIn('--clip', args.clip, 1, Infinity, true);
  if (args.video !== undefined && fromVideo !== undefined) throw new Error('Pass either --video or --from-video, not both.');
  if ((generation !== undefined || clip !== undefined) && fromVideo === undefined) throw new Error('--generation and --clip need --from-video <videoItemId>.');
  if (args.followUp !== undefined) {
    if (!item) throw new Error('--follow-up needs --item <analysisId>: follow-ups add to an existing analysis.');
    if (args.video !== undefined || fromVideo !== undefined) throw new Error('--follow-up reuses the earlier video; leave out --video and --from-video.');
    if (!INTERACTION_ID.test(args.followUp.trim())) throw new Error('--follow-up must be an interaction id.');
    body.previousInteractionId = args.followUp.trim();
  } else if (!item && args.video === undefined && fromVideo === undefined) {
    throw new Error('Choose a video: --video <file|YouTube link> or --from-video <videoItemId>.');
  }
  if (args.video !== undefined) {
    const video = args.video.trim();
    if (isYouTubeUrl(video)) body.source = { kind: 'youtube', url: video };
    else if (/^https?:\/\//i.test(video)) throw new Error(`--video links must be YouTube; download other videos first (got "${video}").`);
    else upload = (await checkVideoReference(video)).path;
  }
  if (fromVideo) body.source = { kind: 'video', videoItemId: fromVideo, ...(generation ? { generationId: generation } : {}), ...(clip !== undefined ? { clip } : {}) };

  const model = args.model?.trim();
  if (args.model !== undefined && !model) throw new Error('--model is empty.');
  if (model) body.model = model;
  const mode = oneOf('--processing', args.processing, ['static', 'agentic'] as const);
  const startSeconds = parseVideoTime('--start', args.start);
  const endSeconds = parseVideoTime('--end', args.end);
  const fps = numberIn('--fps', args.fps, 0, Infinity);
  const clipped = startSeconds !== undefined || endSeconds !== undefined || fps !== undefined;
  if (mode === 'agentic' && clipped) throw new Error('--start, --end, and --fps only apply to static processing.');
  if (mode === 'agentic' && model && !AGENTIC_ANALYSIS_MODELS.includes(model)) throw new Error(`--processing agentic needs one of ${AGENTIC_ANALYSIS_MODELS.join(', ')} (got ${model}).`);
  if (startSeconds !== undefined && endSeconds !== undefined && endSeconds <= startSeconds) throw new Error('--end must be after --start.');
  if (fps === 0) throw new Error('--fps must be greater than 0.');
  if (mode || clipped) {
    body.processing = { mode: mode ?? 'static', ...(startSeconds !== undefined ? { startSeconds } : {}), ...(endSeconds !== undefined ? { endSeconds } : {}), ...(fps !== undefined ? { fps } : {}) };
  }
  const mediaResolution = oneOf('--media-resolution', args.mediaResolution, MEDIA_RESOLUTIONS);
  if (mediaResolution) body.mediaResolution = mediaResolution;
  if (body.previousInteractionId && (body.processing || mediaResolution)) throw new Error('--follow-up reuses the earlier video; leave out --processing, --start, --end, --fps, and --media-resolution.');
  if (args.system !== undefined) {
    if (!args.system.trim()) throw new Error('--system is empty.');
    if (args.system.length > 8000) throw new Error('--system is limited to 8,000 characters.');
    body.systemInstruction = args.system;
  }
  const responseSchema = await readResponseSchema(args.schema);
  if (responseSchema) {
    if (JSON.stringify(responseSchema).length > MAX_RESPONSE_SCHEMA_CHARS) throw new Error(`--schema is limited to ${MAX_RESPONSE_SCHEMA_CHARS.toLocaleString('en-US')} characters of JSON.`);
    body.responseSchema = responseSchema;
  }

  // The two overrides turn narration on, like --instructions turns on --adapt.
  const voice = args.narrateVoice?.trim(); const playlist = args.narratePlaylist?.trim();
  if (args.narrateVoice !== undefined && !voice) throw new Error('--narrate-voice is empty.');
  if (args.narratePlaylist !== undefined && !playlist) throw new Error('--narrate-playlist is empty.');
  if (args.narrate === false && (voice || playlist)) throw new Error('--narrate-voice and --narrate-playlist need narration; drop --no-narrate.');
  if (voice || playlist) body.narrate = { ...(voice ? { voice } : {}), ...(playlist ? { playlist } : {}) };
  else if (args.narrate) body.narrate = true;
  if (body.narrate && body.responseSchema) throw new Error('Narration reads a Markdown answer; leave out --schema or the --narrate flags.');
  return { body, ...(upload ? { upload } : {}) };
}

export const studioAnalyzeCommand = defineCommand({
  meta: { name: 'analyze', description: 'Ask Gemini about a video and save the Markdown answer in your studio' },
  args: {
    prompt: { type: 'string', alias: 'p', description: 'What to ask about the video' },
    input: { type: 'string', alias: 'i', description: 'File containing the prompt (- for stdin)' },
    video: { type: 'string', description: 'A local video (uploaded, up to 200 MiB) or a YouTube link' },
    fromVideo: { type: 'string', description: 'A video item id from your studio' },
    generation: { type: 'string', description: 'With --from-video: the version to analyze (default: its latest result)' },
    clip: { type: 'string', description: 'With --from-video: analyze only this clip number' },
    item: { type: 'string', description: 'Existing analysis id to run again (omitted settings and source are kept)' },
    model: { type: 'string', description: 'Gemini model (default: the studio\'s)' },
    processing: { type: 'string', description: 'static (default) or agentic (long videos, targeted questions)' },
    start: { type: 'string', description: 'Static only: start at this time (90, 20m, MM:SS)' },
    end: { type: 'string', description: 'Static only: stop at this time (90, 20m, MM:SS)' },
    fps: { type: 'string', description: 'Static only: frames sampled per second (default 1)' },
    mediaResolution: { type: 'string', description: `Detail per frame: ${MEDIA_RESOLUTIONS.join(', ')}` },
    system: { type: 'string', description: 'System instruction' },
    schema: { type: 'string', description: 'JSON Schema file; the answer is saved as JSON matching it' },
    followUp: { type: 'string', description: 'With --item: an interactionId from that analysis to ask a follow-up about' },
    narrate: { type: 'boolean', description: 'Narrate the answer with your studio narration defaults' },
    narrateVoice: { type: 'string', description: 'Narration voice (turns on --narrate)' },
    narratePlaylist: { type: 'string', description: 'Playlist id or title for the narration (turns on --narrate)' },
    wait: { type: 'boolean', description: 'Wait, then print the answer on stdout' },
    output: { type: 'string', alias: 'o', description: 'Save the answer here (implies --wait)' },
    timeout: { type: 'string', description: 'Seconds to wait (default 900)' },
    json: { type: 'boolean', description: 'Print JSON' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const { body, upload } = await studioAnalysisBody(await readPrompt(args.input, args.prompt), args);
      await runMediaCommand(connectedClient(), 'analysis', body, { ...args, reference: upload });
    });
  },
});
