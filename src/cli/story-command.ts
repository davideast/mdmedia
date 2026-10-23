import { defineCommand } from 'citty';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfigFile, resolveConfig } from '../config/index.js';
import { buildComic, buildStory, directStory, drawComic, panelFile, parseComic, parseStory, previewHtml, slugify, StoryError } from '../story/index.js';
import type { AudioRuntime, BuildEvent, ComicScript, Composer, DirectEvent, Diagnostic, DrawEvent, ImageModel, LineEvent, RenderCache, Speaker, StoryScript, TextModel, Transcriber, Vision } from '../story/index.js';
import {
  createFileRenderCache,
  createFileSink,
  createGeminiSpeaker,
  createGeminiImageModel,
  createGeminiTextModel,
  createGeminiTranscriber,
  createGeminiVision,
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
      write(`cast: ${Object.entries(c.cast).map(([id, m]) => `${id} (${m.voice})`).join(', ')}; narrator ${'character' in c.narrator ? c.narrator.character : c.narrator.voice}; ${c.scenes.length} scenes`);
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
  args: { file: string; out?: string; json?: boolean; signal?: AbortSignal },
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
    const result = await drawComic(comic, story.cast, { ...deps, signal: args.signal, onEvent });
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
      { file: args.file, out: args.out, json: args.json, signal: controller.signal },
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
  args: { file: string; out?: string; json?: boolean; signal?: AbortSignal },
  deps: { image: ImageModel; vision: Vision; cache: RenderCache; runtime: AudioRuntime; speaker?: Speaker; transcriber?: Transcriber },
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
    : (event: DrawEvent | LineEvent) => {
        if (event.type === 'panel-done' && !event.result.cached) write(`${event.result.ok ? '✓' : '✗'} panel ${event.result.id} (${event.result.attempts} take${event.result.attempts > 1 ? 's' : ''})`);
        if (event.type === 'line-done' && !event.result.ok) write(`✗ ${event.result.id} ${event.result.speaker}: heard "${event.result.heard}"`);
      };
  try {
    const started = Date.now();
    const result = await buildComic({ comic, story, ...deps, sink: createFileSink(outDir), signal: args.signal, onEvent });
    const lines = [...result.lines.values()].map((l) => l.result);
    const summary = {
      panels: result.draw.panels.length,
      panelsFailing: result.draw.panels.filter((p) => !p.ok).length,
      lines: lines.length,
      linesCached: lines.filter((l) => l.cached).length,
      retakes: lines.reduce((n, l) => n + Math.max(0, l.attempts - 1), 0),
      linesFailing: lines.filter((l) => !l.ok).length,
      crowded: result.crowded.filter((c) => c.view === 'page').length,
      crowdedGuided: result.crowded.filter((c) => c.view === 'guided').length,
      wallMs: Date.now() - started,
    };
    await createFileSink(join(outDir, 'comic')).write(
      'comic-build.json',
      JSON.stringify({ schema: 'mdmedia.story.comic-build/1', summary, panels: result.draw.panels, lines, crowded: result.crowded }, null, 2) + '\n'
    );
    write(
      args.json
        ? JSON.stringify({ outDir, summary }, null, 2)
        : `${summary.panels} panels (${summary.panelsFailing} failing), ${summary.lines} lines (${summary.linesCached} cached, ${summary.retakes} retakes, ${summary.linesFailing} failing), ${summary.crowded} crowded (${summary.crowdedGuided} in the guided view) -> ${join(outDir, 'reader', 'index.html')}`
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
      { file: args.file, out: args.out, json: args.json, signal: controller.signal },
      {
        image: createGeminiImageModel({ apiKey, model: args.imageModel }),
        vision: createGeminiVision({ apiKey, model: args.visionModel }),
        cache: createFileRenderCache(args.cache ?? join(args.file, '..', '.mdmedia', 'cache')),
        runtime,
        ...(args.voices
          ? { speaker: createGeminiSpeaker({ apiKey, model: args.voiceModel }), transcriber: createGeminiTranscriber({ apiKey, model: args.transcribeModel }) }
          : {}),
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
    direct: storyDirectCommand,
    draw: storyDrawCommand,
    comic: storyComicCommand,
  },
});
