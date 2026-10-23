import { defineCommand } from 'citty';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfigFile, resolveConfig } from '../config/index.js';
import { buildStory, parseStory, slugify, StoryError } from '../story/index.js';
import type { AudioRuntime, BuildEvent, Composer, Diagnostic, RenderCache, Speaker, Transcriber } from '../story/index.js';
import {
  createFileRenderCache,
  createFileSink,
  createGeminiSpeaker,
  createGeminiTranscriber,
  createLyriaComposer,
  createNodeAudioRuntime,
} from '../story/node/index.js';

/** One diagnostic per line: `file:line:col severity code message`. */
export function formatDiagnostics(file: string, diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) return `${file}: no problems`;
  return diagnostics
    .map((d) => `${file}:${d.source?.line ?? 1}:${d.source?.column ?? 1} ${d.severity} ${d.code} ${d.message}`)
    .join('\n');
}

/** Parses a story file; resolves to the exit code. */
export async function checkStory(file: string, json: boolean, write: (text: string) => void): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(file, 'utf8');
  } catch (error) {
    write(json ? JSON.stringify([{ code: 'unreadable', severity: 'error', message: String(error) }]) : `${file}: cannot read file`);
    return 1;
  }
  const { diagnostics } = await parseStory(markdown, { path: file });
  write(json ? JSON.stringify(diagnostics, null, 2) : formatDiagnostics(file, diagnostics));
  return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

export const storyCheckCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Check a story file and report errors and warnings with their positions',
  },
  args: {
    file: { type: 'positional', description: 'Story markdown file', required: true },
    json: { type: 'boolean', description: 'Print diagnostics as JSON', default: false },
  },
  async run({ args }) {
    process.exitCode = await checkStory(args.file, args.json, (text) => console.log(text));
  },
});

/** Exit codes for story commands (design section 11). */
export const EXIT = { ok: 0, storyErrors: 1, provider: 2, ffmpegMissing: 3, failingChecks: 4, cancelled: 130 } as const;

export interface BuildDeps {
  speaker: Speaker;
  transcriber: Transcriber;
  runtime: AudioRuntime;
  cache: RenderCache;
  composer?: Composer;
}

export interface BuildArgs {
  file: string;
  out?: string;
  cache?: string;
  json?: boolean;
  music?: boolean;
  signal?: AbortSignal;
}

/** Builds a story; resolves to the exit code. `deps` replaces providers in tests. */
export async function runStoryBuild(args: BuildArgs, deps: BuildDeps, write: (text: string) => void): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(args.file, 'utf8');
  } catch {
    write(`${args.file}: cannot read file`);
    return EXIT.storyErrors;
  }
  const outDir = args.out ?? join('dist', slugify(basename(args.file, extname(args.file))));
  const onEvent = args.json ? undefined : (event: BuildEvent) => {
    if (event.type === 'line-retake') write(`↻ ${event.id} retake ${event.attempt}: missing [${event.check.missing.join(' ')}] extra [${event.check.extra.join(' ')}]`);
    if (event.type === 'line-fallback') write(`⚠ ${event.id} refused; shorter note (level ${event.level})`);
    if (event.type === 'music-done') {
      const m = event.result;
      write(`${m.ok ? '♪' : '✗'} music ${m.scene}${m.cached ? ' (cached)' : ''}${m.error ? `  ${m.error}` : ''}`);
    }
    if (event.type === 'line-done') {
      const r = event.result;
      write(`${r.refused ? '✗' : r.ok ? '✓' : '✗'} ${r.id}${r.cached ? ' (cached)' : ''}${r.ok ? '' : `  heard "${r.heard}"`}`);
    }
    if (event.type === 'build-done') {
      const s = event.summary;
      write(`${s.lines} lines, ${s.cached} cached, ${s.retakes} retakes, ${s.fallbacks} fallbacks, ${s.failures} failing, ${s.musicClips} music clips, ${s.audioSeconds} s audio -> ${outDir}`);
    }
  };
  try {
    const { diagnostics, build } = await buildStory({
      source: { path: args.file, markdown },
      out: createFileSink(outDir),
      ...deps,
      music: args.music !== false,
      tool: { name: 'mdmedia', version: toolVersion() },
      signal: args.signal,
      onEvent,
    });
    if (!build) {
      write(args.json ? JSON.stringify({ diagnostics }, null, 2) : formatDiagnostics(args.file, diagnostics));
      return EXIT.storyErrors;
    }
    if (args.json) write(JSON.stringify({ outDir, summary: build.summary, failing: build.lines.filter((l) => !l.ok) }, null, 2));
    return build.summary.failures > 0 ? EXIT.failingChecks : EXIT.ok;
  } catch (error) {
    if (args.signal?.aborted) return EXIT.cancelled;
    if (error instanceof StoryError && error.code === 'ffmpeg-missing') { write(error.message); return EXIT.ffmpegMissing; }
    write(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.provider;
  }
}

function toolVersion(): string {
  try {
    return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export const storyBuildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Voice every line of a story in context, check each against the script, score its scenes, and mix an MP3',
  },
  args: {
    file: { type: 'positional', description: 'Story markdown file', required: true },
    out: { type: 'string', description: 'Output folder (default dist/<file name>)' },
    cache: { type: 'string', description: 'Render cache folder (default .mdmedia/cache next to the story)' },
    voiceModel: { type: 'string', description: 'Speech model (default gemini-3.8-flash-tts)' },
    transcribeModel: { type: 'string', description: 'Transcription model for checks (default gemini-3.5-flash-lite)' },
    music: { type: 'boolean', description: 'Score scenes that have music cues (use --no-music to skip)', default: true },
    musicModel: { type: 'string', description: 'Music model (default lyria-3-clip-preview)' },
    json: { type: 'boolean', description: 'Print the build summary as JSON', default: false },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const apiKey = resolveConfig({}, fileConfig, process.env).apiKey;
    if (!apiKey) {
      console.error('A Gemini API key is required: set GEMINI_API_KEY or apiKey in .mdmedia.json.');
      process.exitCode = EXIT.provider;
      return;
    }
    let runtime: AudioRuntime;
    try {
      runtime = createNodeAudioRuntime();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT.ffmpegMissing;
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.exitCode = await runStoryBuild(
      { file: args.file, out: args.out, cache: args.cache, json: args.json, music: args.music, signal: controller.signal },
      {
        speaker: createGeminiSpeaker({ apiKey, model: args.voiceModel }),
        transcriber: createGeminiTranscriber({ apiKey, model: args.transcribeModel }),
        runtime,
        cache: createFileRenderCache(args.cache ?? join(args.file, '..', '.mdmedia', 'cache')),
        composer: args.music ? createLyriaComposer({ apiKey, model: args.musicModel }) : undefined,
      },
      (text) => console.log(text)
    );
  },
});

export const storyCommand = defineCommand({
  meta: {
    name: 'story',
    description: 'Build stories into audio dramas and graphic novels',
  },
  subCommands: {
    check: storyCheckCommand,
    build: storyBuildCommand,
  },
});
