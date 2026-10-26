import { defineCommand } from 'citty';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfigFile, resolveConfig } from '../config/index.js';
import { adaptStory, buildComic, buildStory, compareHtml, directStory, drawComic, panelFile, parseComic, parseStory, previewHtml, slugify, StoryError } from '../story/index.js';
import type { AdaptEvent, AudioRuntime, BuildEvent, CastEvent, ComicScript, Composer, DirectEvent, Diagnostic, DrawEvent, ImageModel, LineEvent, RenderCache, Speaker, StoryScript, TextModel, Transcriber, Vision, VoiceJudge } from '../story/index.js';
import {
  createFileRenderCache,
  createFileSink,
  createGeminiSpeaker,
  createGeminiImageModel,
  createGeminiTextModel,
  createGeminiTranscriber,
  createGeminiVision,
  createGeminiVoiceJudge,
  createLyriaComposer,
  createNodeAudioRuntime,
  addToComicLock,
  readComicLock,
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
  const { diagnostics } = isComicScript(markdown) ? await loadComic(file, markdown) : await parseStory(markdown, { path: file });
  write(json ? JSON.stringify(diagnostics, null, 2) : formatDiagnostics(file, diagnostics));
  return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

/** A comic script names the story it draws from in its front matter. */
export function isComicScript(markdown: string): boolean {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  return Boolean(fm && /^story:\s*\S/m.test(fm[1]!));
}

/** Parses a comic script with the cast of the story file its `story:` names, relative to the script. */
export async function loadComic(file: string, markdown: string): Promise<{ comic?: ComicScript; story?: StoryScript; diagnostics: Diagnostic[] }> {
  const storyPath = join(dirname(file), /^story:\s*(.+)$/m.exec(markdown)![1]!.trim());
  let storyMarkdown: string;
  try {
    storyMarkdown = await readFile(storyPath, 'utf8');
  } catch {
    return { diagnostics: [{ code: 'missing-field', severity: 'error', message: `The story file ${storyPath} named by story: cannot be read.`, source: { line: 1, column: 1, endLine: 1, endColumn: 1 } }] };
  }
  const story = await parseStory(storyMarkdown, { path: storyPath });
  if (!story.script) {
    return { diagnostics: [{ code: 'missing-field', severity: 'error', message: `The story file ${storyPath} has errors; run story check on it.`, source: { line: 1, column: 1, endLine: 1, endColumn: 1 } }] };
  }
  const { comic, diagnostics } = await parseComic(markdown, { path: file, cast: story.script.cast });
  return { comic, story: story.script, diagnostics };
}

export const storyCheckCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Check a story file or comic script and report errors and warnings with their positions',
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
  judge?: VoiceJudge;
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
    if (event.type === 'cast-done') write(castLine(event));
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

/** `♫ ODILE cast as Autonoe (9/10): an elderly Northern woman's voice, dry rasp` */
function castLine(event: CastEvent): string {
  const r = event.result;
  const top = r.ranked[0];
  return `♫ ${r.id} cast as ${r.voice}${r.cached ? ' (cached)' : top ? ` (${top.fit}/10 of ${r.ranked.length} auditions): ${top.note}` : ''}`;
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
        judge: createGeminiVoiceJudge({ apiKey }),
      },
      (text) => console.log(text)
    );
  },
});

/**
 * Directs a raw story into a story file; resolves to the exit code. The file is
 * written even when problems remain, so a person can finish it.
 */
export async function runStoryDirect(
  args: { file: string; out: string; json?: boolean; signal?: AbortSignal },
  writer: TextModel,
  write: (text: string) => void
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(args.file, 'utf8');
  } catch {
    write(`${args.file}: cannot read file`);
    return EXIT.storyErrors;
  }
  const onEvent = args.json ? undefined : (event: DirectEvent) => {
    if (event.type === 'cast-done') {
      const c = event.cast;
      write(`cast: ${Object.keys(c.cast).join(', ')}; narrator ${'character' in c.narrator ? c.narrator.character : 'NARRATOR'}; ${c.scenes.length} scenes`);
    }
    if (event.type === 'scene-done') write(`✓ ${event.title}`);
    if (event.type === 'repair') write(`↻ repair round ${event.round}: ${event.scenes.join(', ')}`);
  };
  try {
    const { markdown, report } = await directStory(raw, { writer, signal: args.signal, onEvent });
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, markdown);
    if (args.json) write(JSON.stringify({ out: args.out, ...report }, null, 2));
    else {
      write(`${report.lines} lines in ${report.scenes} scenes -> ${args.out}`);
      for (const a of report.additions) write(`+ added: ${a}`);
      for (const r of report.replaced) write(`~ replaced: ${r}`);
      for (const p of report.remaining) write(`✗ ${p.scene}: ${p.detail}`);
      if (!report.remaining.length) write('no problems');
    }
    return report.remaining.length ? EXIT.storyErrors : EXIT.ok;
  } catch (error) {
    if (args.signal?.aborted) return EXIT.cancelled;
    write(`Direct failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.provider;
  }
}

export const storyDirectCommand = defineCommand({
  meta: {
    name: 'direct',
    description: 'Turn an author\'s raw story into a story file: cast, voices, scenes, music cues and a cue on every line',
  },
  args: {
    file: { type: 'positional', description: 'The raw story (markdown or plain text)', required: true },
    out: { type: 'string', alias: 'o', description: 'Story file to write', required: true },
    model: { type: 'string', description: 'Text model (default gemini-3.5-flash)' },
    json: { type: 'boolean', description: 'Print the report as JSON', default: false },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const apiKey = resolveConfig({}, fileConfig, process.env).apiKey;
    if (!apiKey) {
      console.error('A Gemini API key is required: set GEMINI_API_KEY or apiKey in .mdmedia.json.');
      process.exitCode = EXIT.provider;
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.exitCode = await runStoryDirect(
      { file: args.file, out: args.out, json: args.json, signal: controller.signal },
      createGeminiTextModel({ apiKey, model: args.model }),
      (text) => console.log(text)
    );
  },
});

/** Draws a comic script's panels; resolves to the exit code. `deps` replaces providers in tests. */
export async function runStoryDraw(
  args: { file: string; out?: string; json?: boolean; redraw?: boolean; signal?: AbortSignal },
  deps: { image: ImageModel; vision: Vision; cache: RenderCache },
  write: (text: string) => void
): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(args.file, 'utf8');
  } catch {
    write(`${args.file}: cannot read file`);
    return EXIT.storyErrors;
  }
  if (!isComicScript(markdown)) {
    write(`${args.file}: not a comic script (its front matter needs story:)`);
    return EXIT.storyErrors;
  }
  const { comic, story, diagnostics } = await loadComic(args.file, markdown);
  if (!comic || !story) {
    write(args.json ? JSON.stringify({ diagnostics }, null, 2) : formatDiagnostics(args.file, diagnostics));
    return EXIT.storyErrors;
  }
  const outDir = join(args.out ?? join('dist', slugify(comic.meta.title)), 'comic');
  const onEvent = args.json ? undefined : (event: DrawEvent) => {
    if (event.type === 'sheet-done') write(`✓ character sheet${event.cached ? ' (cached)' : ''}`);
    if (event.type === 'staging-done') write(`${event.result.ok ? '✓' : '✗'} staging ${event.result.index}${event.result.cached ? ' (cached)' : ` (${event.result.attempts} take${event.result.attempts > 1 ? 's' : ''})`}`);
    if (event.type === 'panel-done') {
      const r = event.result;
      const failed = r.questions.filter((_, i) => !r.answers[i]);
      write(`${r.ok ? '✓' : '✗'} panel ${r.id}${r.cached ? ' (cached)' : ` (${r.attempts} take${r.attempts > 1 ? 's' : ''})`}${failed.length ? `  failed: ${failed.join(' | ')}` : ''}`);
    }
  };
  try {
    const started = Date.now();
    const result = await drawComic(comic, story.cast, { ...deps, redraw: args.redraw, signal: args.signal, onEvent });
    const sink = createFileSink(outDir);
    await sink.write('art/sheet.png', result.images.get('sheet')!.bytes);
    for (const s of result.stagings) await sink.write(`art/staging-${s.index}.png`, result.images.get(`staging-${s.index}`)!.bytes);
    for (const p of result.panels) await sink.write(panelFile(p.id), result.images.get(p.id)!.bytes);
    const panelsById = new Map(result.panels.map((p) => [p.id, p]));
    const drawn = {
      ...comic,
      pages: comic.pages.map((page) => ({
        ...page,
        panels: page.panels.map((panel) => ({ ...panel, image: panelFile(panel.id), heads: panelsById.get(panel.id)!.heads, check: { ok: panelsById.get(panel.id)!.ok, attempts: panelsById.get(panel.id)!.attempts } })),
      })),
    };
    await sink.write('comic.json', JSON.stringify(drawn, null, 2) + '\n');
    const summary = {
      panels: result.panels.length,
      cached: result.panels.filter((p) => p.cached).length,
      redraws: result.panels.reduce((n, p) => n + Math.max(0, p.attempts - 1), 0) + result.stagings.reduce((n, s) => n + Math.max(0, s.attempts - 1), 0),
      failing: result.panels.filter((p) => !p.ok).length + result.stagings.filter((s) => !s.ok).length,
      headBoxes: result.panels.reduce((n, p) => n + p.heads.length, 0),
      wallMs: Date.now() - started,
    };
    await sink.write('draw.json', JSON.stringify({ schema: 'mdmedia.story.draw/1', models: { image: deps.image.model, vision: deps.vision.model }, summary, sheet: result.sheet, stagings: result.stagings, panels: result.panels }, null, 2) + '\n');
    await sink.write('preview.html', previewHtml(comic, result));
    write(args.json ? JSON.stringify({ outDir, summary }, null, 2) : `${summary.panels} panels, ${summary.cached} cached, ${summary.redraws} redraws, ${summary.failing} failing, ${summary.headBoxes} head boxes -> ${outDir}`);
    return summary.failing ? EXIT.failingChecks : EXIT.ok;
  } catch (error) {
    if (args.signal?.aborted) return EXIT.cancelled;
    write(`Draw failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.provider;
  }
}

export const storyDrawCommand = defineCommand({
  meta: {
    name: 'draw',
    description: 'Draw a comic script: character sheet, staging, every panel in context, each checked; then head boxes for lettering',
  },
  args: {
    file: { type: 'positional', description: 'Comic script', required: true },
    out: { type: 'string', description: 'Output folder (default dist/<title>)' },
    cache: { type: 'string', description: 'Render cache folder (default .mdmedia/cache next to the script)' },
    imageModel: { type: 'string', description: 'Image model (default gemini-3-pro-image)' },
    visionModel: { type: 'string', description: 'Model for checks and head boxes (default gemini-3.5-flash)' },
    redraw: { type: 'boolean', description: 'Draw again panels that failed their checks in an earlier build', default: false },
    json: { type: 'boolean', description: 'Print the summary as JSON', default: false },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const apiKey = resolveConfig({}, fileConfig, process.env).apiKey;
    if (!apiKey) {
      console.error('A Gemini API key is required: set GEMINI_API_KEY or apiKey in .mdmedia.json.');
      process.exitCode = EXIT.provider;
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.exitCode = await runStoryDraw(
      { file: args.file, out: args.out, json: args.json, redraw: args.redraw, signal: controller.signal },
      {
        image: createGeminiImageModel({ apiKey, model: args.imageModel }),
        vision: createGeminiVision({ apiKey, model: args.visionModel }),
        cache: createFileRenderCache(args.cache ?? join(args.file, '..', '.mdmedia', 'cache')),
      },
      (text) => console.log(text)
    );
  },
});

/** Builds the graphic novel for a comic script; resolves to the exit code. `deps` replaces providers in tests. */
export async function runStoryComic(
  args: { file: string; out?: string; json?: boolean; redraw?: boolean; unlock?: string[]; signal?: AbortSignal },
  deps: { image: ImageModel; vision: Vision; cache: RenderCache; runtime: AudioRuntime; speaker?: Speaker; transcriber?: Transcriber; judge?: VoiceJudge },
  write: (text: string) => void
): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(args.file, 'utf8');
  } catch {
    write(`${args.file}: cannot read file`);
    return EXIT.storyErrors;
  }
  if (!isComicScript(markdown)) {
    write(`${args.file}: not a comic script (its front matter needs story:)`);
    return EXIT.storyErrors;
  }
  const { comic, story, diagnostics } = await loadComic(args.file, markdown);
  if (!comic || !story) {
    write(args.json ? JSON.stringify({ diagnostics }, null, 2) : formatDiagnostics(args.file, diagnostics));
    return EXIT.storyErrors;
  }
  const outDir = args.out ?? join('dist', slugify(comic.meta.title));
  const onEvent = args.json
    ? undefined
    : (event: DrawEvent | LineEvent | CastEvent) => {
        if (event.type === 'cast-done') write(castLine(event));
        if (event.type === 'panel-done' && !event.result.cached) write(`${event.result.ok ? '✓' : '✗'} panel ${event.result.id} (${event.result.attempts} take${event.result.attempts > 1 ? 's' : ''})`);
        if (event.type === 'line-done' && !event.result.ok) write(`✗ ${event.result.id} ${event.result.speaker}: heard "${event.result.heard}"`);
      };
  try {
    const started = Date.now();
    const lock = await readComicLock(args.file, args.unlock ?? []);
    if (!args.json && (lock.images.size || lock.lines.size || Object.keys(lock.cast).length)) {
      write(`locked: ${lock.images.size} panels, ${Object.keys(lock.cast).length} cast voices, ${lock.lines.size} lines`);
    }
    const result = await buildComic({ comic, story, ...deps, sink: createFileSink(outDir), redraw: args.redraw, lock, signal: args.signal, onEvent });
    const lines = [...result.lines.values()].map((l) => l.result);
    const summary = {
      panels: result.draw.panels.length,
      panelsFailing: result.draw.panels.filter((p) => !p.ok).length,
      lines: lines.length,
      linesCached: lines.filter((l) => l.cached).length,
      retakes: lines.reduce((n, l) => n + Math.max(0, l.attempts - 1), 0),
      linesFailing: lines.filter((l) => !l.ok).length,
      // Panels with someone placed in them but no head found: lettering there can't avoid faces.
      headsMissing: result.draw.panels.filter((p) => !p.heads.length && Object.keys(comic.pages.flatMap((pg) => pg.panels).find((x) => x.id === p.id)!.positions).length).length,
      crowded: result.crowded.filter((c) => c.view === 'page').length,
      crowdedGuided: result.crowded.filter((c) => c.view === 'guided').length,
      wallMs: Date.now() - started,
    };
    await createFileSink(join(outDir, 'comic')).write(
      'comic-build.json',
      JSON.stringify({ schema: 'mdmedia.story.comic-build/1', summary, casting: result.casting, panels: result.draw.panels, lines, crowded: result.crowded }, null, 2) + '\n'
    );
    write(
      args.json
        ? JSON.stringify({ outDir, summary }, null, 2)
        : `${summary.panels} panels (${summary.panelsFailing} failing), ${summary.lines} lines (${summary.linesCached} cached, ${summary.retakes} retakes, ${summary.linesFailing} failing), ${summary.crowded} crowded (${summary.crowdedGuided} in the guided view), ${summary.headsMissing} panels without head boxes -> ${join(outDir, 'reader', 'index.html')}`
    );
    return summary.panelsFailing || summary.linesFailing || summary.crowded ? EXIT.failingChecks : EXIT.ok;
  } catch (error) {
    if (args.signal?.aborted) return EXIT.cancelled;
    write(`Comic build failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.provider;
  }
}

export const storyComicCommand = defineCommand({
  meta: {
    name: 'comic',
    description: 'Build the graphic novel for a comic script: draw (cached), letter, voice every caption and balloon, and write a reader',
  },
  args: {
    file: { type: 'positional', description: 'Comic script', required: true },
    out: { type: 'string', description: 'Output folder (default dist/<title>)' },
    cache: { type: 'string', description: 'Render cache folder (default .mdmedia/cache next to the script)' },
    voices: { type: 'boolean', description: 'Voice captions and balloons (use --no-voices for a lettering pass)', default: true },
    redraw: { type: 'boolean', description: 'Draw again panels that failed their checks in an earlier build', default: false },
    unlock: { type: 'string', description: 'Comma-separated panel, cast or line ids to release from the lock for this build' },
    imageModel: { type: 'string', description: 'Image model (default gemini-3-pro-image)' },
    visionModel: { type: 'string', description: 'Model for checks and head boxes (default gemini-3.5-flash)' },
    voiceModel: { type: 'string', description: 'Speech model (default gemini-3.8-flash-tts)' },
    transcribeModel: { type: 'string', description: 'Transcription model for checks (default gemini-3.5-flash-lite)' },
    json: { type: 'boolean', description: 'Print the summary as JSON', default: false },
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
    process.exitCode = await runStoryComic(
      { file: args.file, out: args.out, json: args.json, redraw: args.redraw, unlock: args.unlock ? String(args.unlock).split(',').map((s) => s.trim()).filter(Boolean) : [], signal: controller.signal },
      {
        image: createGeminiImageModel({ apiKey, model: args.imageModel }),
        vision: createGeminiVision({ apiKey, model: args.visionModel }),
        cache: createFileRenderCache(args.cache ?? join(args.file, '..', '.mdmedia', 'cache')),
        runtime,
        ...(args.voices
          ? {
              speaker: createGeminiSpeaker({ apiKey, model: args.voiceModel }),
              transcriber: createGeminiTranscriber({ apiKey, model: args.transcribeModel }),
              judge: createGeminiVoiceJudge({ apiKey }),
            }
          : {}),
      },
      (text) => console.log(text)
    );
  },
});

/**
 * Adapts a story file into a comic script; resolves to the exit code. The file
 * is written even when problems remain, so a person can finish it.
 */
export async function runStoryAdapt(
  args: { file: string; out: string; style?: string; scene?: string; json?: boolean; signal?: AbortSignal },
  writer: TextModel,
  write: (text: string) => void
): Promise<number> {
  let markdown: string;
  try {
    markdown = await readFile(args.file, 'utf8');
  } catch {
    write(`${args.file}: cannot read file`);
    return EXIT.storyErrors;
  }
  const onEvent = args.json ? undefined : (event: AdaptEvent) => {
    if (event.type === 'scene-done') write(`✓ ${event.title}`);
    if (event.type === 'repair') write(`↻ repair round ${event.round}: ${event.scenes.join(', ')}`);
  };
  try {
    const story = relative(dirname(args.out), args.file).split('\\').join('/');
    const result = await adaptStory(markdown, { writer, story, style: args.style, scene: args.scene, signal: args.signal, onEvent });
    if (!result.markdown || !result.report) {
      write(args.json ? JSON.stringify({ diagnostics: result.diagnostics }, null, 2) : formatDiagnostics(args.file, result.diagnostics));
      return EXIT.storyErrors;
    }
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, result.markdown);
    const r = result.report;
    if (args.json) write(JSON.stringify({ out: args.out, ...r }, null, 2));
    else {
      write(`${r.pages} pages, ${r.panels} panels, ${r.balloons} balloons, ${r.captions} captions (${r.narration.captioned} of ${r.narration.lines} narration lines kept as captions) -> ${args.out}`);
      for (const p of r.remaining) write(`✗ ${p.scene}: ${p.problem}`);
      if (!r.remaining.length) write('no problems');
    }
    return r.remaining.length ? EXIT.storyErrors : EXIT.ok;
  } catch (error) {
    if (args.signal?.aborted) return EXIT.cancelled;
    write(`Adapt failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.provider;
  }
}

export const storyAdaptCommand = defineCommand({
  meta: {
    name: 'adapt',
    description: 'Turn a story file into a comic script: pages, panels, shots, acting notes and which lines go where',
  },
  args: {
    file: { type: 'positional', description: 'Story file', required: true },
    out: { type: 'string', alias: 'o', description: 'Comic script to write', required: true },
    style: { type: 'string', description: 'Art style: flat, watercolor, manga, or your own description (default flat)' },
    scene: { type: 'string', description: 'Adapt only the scenes whose title contains this' },
    model: { type: 'string', description: 'Text model (default gemini-3.5-flash)' },
    json: { type: 'boolean', description: 'Print the report as JSON', default: false },
  },
  async run({ args }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const apiKey = resolveConfig({}, fileConfig, process.env).apiKey;
    if (!apiKey) {
      console.error('A Gemini API key is required: set GEMINI_API_KEY or apiKey in .mdmedia.json.');
      process.exitCode = EXIT.provider;
      return;
    }
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.exitCode = await runStoryAdapt(
      { file: args.file, out: args.out, style: args.style, scene: args.scene, json: args.json, signal: controller.signal },
      createGeminiTextModel({ apiKey, model: args.model }),
      (text) => console.log(text)
    );
  },
});

/**
 * Locks approved work for a comic: panel images from a folder of
 * `panel-P-N` images, cast voices from a build's comic-build.json, line takes
 * from a build's comic/lines folder. Resolves to the exit code.
 */
export async function runStoryLock(
  args: { file: string; art?: string; castFrom?: string; linesFrom?: string; only?: string[] },
  write: (text: string) => void
): Promise<number> {
  const keep = (id: string) => !args.only?.length || args.only.includes(id);
  const images = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  if (args.art) {
    for (const name of await readdir(args.art)) {
      const m = /^panel-(\d+)-(\d+)\.(webp|png|jpg)$/.exec(name);
      if (!m || !keep(`${m[1]}.${m[2]}`)) continue;
      images.set(`${m[1]}.${m[2]}`, { bytes: new Uint8Array(await readFile(join(args.art, name))), mimeType: m[3] === 'webp' ? 'image/webp' : m[3] === 'jpg' ? 'image/jpeg' : 'image/png' });
    }
  }
  const cast: Record<string, string> = {};
  if (args.castFrom) {
    const report = JSON.parse(await readFile(args.castFrom, 'utf8')) as { casting?: Array<{ id: string; voice: string }> };
    for (const c of report.casting ?? []) if (keep(c.id)) cast[c.id] = c.voice;
  }
  const lines = new Map<string, Uint8Array>();
  if (args.linesFrom) {
    const { pcmFromWav } = await import('../story/index.js');
    for (const name of await readdir(args.linesFrom)) {
      const m = /^(\d+)-(\d+)-(\d+)\.wav$/.exec(name);
      if (!m || !keep(`${m[1]}.${m[2]}-${m[3]}`)) continue;
      lines.set(`${m[1]}.${m[2]}-${m[3]}`, pcmFromWav(new Uint8Array(await readFile(join(args.linesFrom, name)))));
    }
  }
  if (!images.size && !Object.keys(cast).length && !lines.size) {
    write('Nothing to lock: give --art, --cast-from or --lines-from.');
    return EXIT.storyErrors;
  }
  const m = await addToComicLock(args.file, { images, cast, lines });
  write(`locked ${images.size} panels, ${Object.keys(cast).length} cast voices, ${lines.size} lines; the lock now holds ${Object.keys(m.panels).length} panels, ${Object.keys(m.cast).length} voices, ${Object.keys(m.lines).length} lines`);
  return EXIT.ok;
}

export const storyLockCommand = defineCommand({
  meta: { name: 'lock', description: 'Lock approved panels, cast voices or lines for a comic, so builds use them as they are' },
  args: {
    file: { type: 'positional', description: 'Comic script', required: true },
    art: { type: 'string', description: 'Folder of panel-P-N images to lock' },
    castFrom: { type: 'string', description: "A build's comic/comic-build.json, to lock its cast voices" },
    linesFrom: { type: 'string', description: "A build's comic/lines folder, to lock its line takes" },
    only: { type: 'string', description: 'Comma-separated ids to lock (default: everything given)' },
  },
  async run({ args }) {
    process.exitCode = await runStoryLock(
      { file: args.file, art: args.art, castFrom: args.castFrom, linesFrom: args.linesFrom, only: args.only ? String(args.only).split(',').map((s) => s.trim()) : undefined },
      (text) => console.log(text)
    );
  },
});

/** The reader data inlined in a reader's index.html. */
async function readerData(readerDir: string) {
  const html = await readFile(join(readerDir, 'index.html'), 'utf8');
  const json = /const COMIC = (.*);\n/.exec(html)?.[1];
  if (!json) throw new Error(`${readerDir} is not a story reader.`);
  return JSON.parse(json.replace(/\\u003c/g, '<')) as import('../story/index.js').ReaderData;
}

/**
 * Writes a before/after review page for two reader builds of one comic, with
 * both builds' art and audio copied beside it. Resolves to the exit code.
 */
export async function runStoryCompare(
  args: { before: string; after: string; out: string; labels?: [string, string]; title?: string; onlyChanged?: boolean },
  write: (text: string) => void
): Promise<number> {
  const before = await readerData(args.before);
  const after = await readerData(args.after);
  const same = async (a: string, b: string) => {
    try {
      return Buffer.compare(await readFile(a), await readFile(b)) === 0;
    } catch {
      return false;
    }
  };
  const changedArt = new Set<string>();
  const changedAudio = new Set<string>();
  const beforePanels = new Map(before.pages.flatMap((p) => p.panels).map((p) => [p.id, p]));
  for (const panel of after.pages.flatMap((p) => p.panels)) {
    const old = beforePanels.get(panel.id);
    if (!old || !(await same(join(args.before, old.image), join(args.after, panel.image)))) changedArt.add(panel.id);
    for (const [i, item] of panel.items.entries()) {
      const oldItem = old?.items[i];
      if (!('audio' in item) || !item.audio) continue;
      if (!oldItem || !('audio' in oldItem) || !oldItem.audio || !(await same(join(args.before, oldItem.audio), join(args.after, item.audio)))) changedAudio.add(`${panel.id}-${i}`);
    }
  }
  for (const [side, from] of [['before', args.before], ['after', args.after]] as const) {
    for (const sub of ['img', 'audio']) {
      const src = join(from, sub);
      const dst = join(args.out, side, sub);
      await mkdir(dst, { recursive: true });
      for (const name of await readdir(src).catch(() => [] as string[])) await copyFile(join(src, name), join(dst, name));
    }
  }
  const [beforeLabel, afterLabel] = args.labels ?? ['Before', 'After'];
  await writeFile(
    join(args.out, 'index.html'),
    compareHtml({
      title: args.title ?? `${after.title}: before and after`,
      before: { label: beforeLabel, data: before, root: 'before/' },
      after: { label: afterLabel, data: after, root: 'after/' },
      changedArt,
      changedAudio,
      onlyChanged: args.onlyChanged,
    })
  );
  write(`${changedArt.size} panels with changed art, ${changedAudio.size} lines with new takes -> ${join(args.out, 'index.html')}`);
  return EXIT.ok;
}

export const storyCompareCommand = defineCommand({
  meta: { name: 'compare', description: 'Write a before/after review page for two reader builds of a comic' },
  args: {
    before: { type: 'positional', description: 'The earlier reader folder', required: true },
    after: { type: 'positional', description: 'The later reader folder', required: true },
    out: { type: 'string', alias: 'o', description: 'Folder to write the review page into', required: true },
    labels: { type: 'string', description: 'Two labels, comma-separated (default Before,After)' },
    title: { type: 'string', description: 'Page title' },
    onlyChanged: { type: 'boolean', description: 'Show only panels whose art or voices changed', default: false },
  },
  async run({ args }) {
    const labels = args.labels ? (String(args.labels).split(',').map((s) => s.trim()) as [string, string]) : undefined;
    process.exitCode = await runStoryCompare({ before: args.before, after: args.after, out: args.out, labels, title: args.title, onlyChanged: args.onlyChanged }, (text) => console.log(text));
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
    direct: storyDirectCommand,
    draw: storyDrawCommand,
    comic: storyComicCommand,
    adapt: storyAdaptCommand,
    lock: storyLockCommand,
    compare: storyCompareCommand,
  },
});
