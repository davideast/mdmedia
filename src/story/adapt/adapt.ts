import { parseComic } from '../comic/parse.js';
import { limiter } from '../limit.js';
import { parseStory } from '../parse.js';
import type { TextModel } from '../ports.js';
import type { Diagnostic, Line, Scene, StoryScript } from '../types.js';
import { assembleComic, markOffPanel, sceneLineIds, type SceneAdaptation, type SceneLines } from './assemble.js';
import { adaptationProblems } from './fidelity.js';
import { ADAPT_INSTRUCTION, ADAPT_REPAIR_INSTRUCTION } from './prompts.js';

export const MAX_ADAPT_REPAIR_ROUNDS = 2;

export interface AdaptReport {
  scenes: number;
  pages: number;
  panels: number;
  balloons: number;
  captions: number;
  /** Narration lines in the adapted scenes, and how many kept a caption. */
  narration: { lines: number; captioned: number };
  repairRounds: number;
  /** Problems left after the last repair round, by scene. */
  remaining: Array<{ scene: string; problem: string }>;
}

export type AdaptEvent =
  | { type: 'scene-done'; title: string }
  | { type: 'repair'; round: number; scenes: string[] }
  | { type: 'adapt-done'; report: AdaptReport };

export interface AdaptOptions {
  writer: TextModel;
  /** How the comic script names its story file: a path relative to the comic. */
  story: string;
  style?: string;
  /** Adapt only the scenes whose title contains this. */
  scene?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: AdaptEvent) => void;
}

export interface AdaptResult {
  markdown?: string;
  /** Problems in the story file stop the adapter before it starts. */
  diagnostics: Diagnostic[];
  report?: AdaptReport;
}

interface Draft {
  scene: Scene;
  lines: SceneLines;
  reply: string;
  adaptation?: SceneAdaptation;
  problems: string[];
}

/**
 * The comic director: turns a story file into a comic script. Each scene is
 * adapted by a text model that chooses pages, panels, shots, acting and which
 * lines go where; code writes the notation, holds the words to the story, and
 * sends each scene's problems back, up to MAX_ADAPT_REPAIR_ROUNDS times.
 */
export async function adaptStory(markdown: string, options: AdaptOptions): Promise<AdaptResult> {
  const { script, diagnostics } = await parseStory(markdown, { path: options.story });
  if (!script) return { diagnostics };
  const emit = options.onEvent ?? (() => {});
  const all = script.chapters.flatMap((c) => c.scenes);
  const scenes = options.scene ? all.filter((s) => (s.title ?? '').toLowerCase().includes(options.scene!.toLowerCase())) : all;
  if (!scenes.length) throw new Error(`No scene title contains "${options.scene}".`);

  const limit = limiter(options.concurrency ?? 3);
  let drafts: Draft[] = await Promise.all(
    scenes.map((scene) =>
      limit(async () => {
        const lines = sceneLineIds(scene.segments.filter((s): s is Line => s.kind === 'line'));
        const previous = all[all.indexOf(scene) - 1];
        const reply = await options.writer.generate({ system: ADAPT_INSTRUCTION, prompt: scenePrompt(script, scene, lines, previous), json: true, signal: options.signal });
        emit({ type: 'scene-done', title: scene.title ?? scene.id });
        return review({ scene, lines, reply, problems: [] }, script);
      })
    )
  );

  const title = options.scene && scenes.length === 1 ? `${script.meta.title} — ${scenes[0]!.title}` : script.meta.title;
  const meta = { title, story: options.story, style: options.style ?? 'flat' };
  let assembled = await assembleAndCheck(meta, drafts, script);
  let rounds = 0;
  while (assembled.drafts.some((d) => d.problems.length) && rounds < MAX_ADAPT_REPAIR_ROUNDS) {
    rounds++;
    const failing = assembled.drafts.filter((d) => d.problems.length);
    emit({ type: 'repair', round: rounds, scenes: failing.map((d) => d.scene.title ?? d.scene.id) });
    drafts = await Promise.all(
      assembled.drafts.map((d) =>
        d.problems.length
          ? limit(async () => {
              const reply = await options.writer.generate({ system: ADAPT_REPAIR_INSTRUCTION, prompt: repairPrompt(script, d, all), json: true, signal: options.signal });
              return review({ ...d, reply, problems: [] }, script);
            })
          : Promise.resolve(d)
      )
    );
    assembled = await assembleAndCheck(meta, drafts, script);
  }

  const done = assembled.drafts.filter((d) => d.adaptation);
  let panels = 0;
  let balloons = 0;
  let captions = 0;
  let narrationLines = 0;
  let captioned = 0;
  for (const d of done) {
    const kept = new Set<string>();
    for (const page of d.adaptation!.pages) {
      for (const panel of page.panels) {
        panels++;
        for (const item of panel.items) {
          if (!('line' in item)) continue;
          if (d.lines.get(item.line)?.narration) {
            captions++;
            kept.add(item.line);
          } else balloons++;
        }
      }
    }
    narrationLines += [...d.lines.values()].filter((l) => l.narration).length;
    captioned += kept.size;
  }
  const report: AdaptReport = {
    scenes: scenes.length,
    pages: done.reduce((n, d) => n + d.adaptation!.pages.length, 0),
    panels,
    balloons,
    captions,
    narration: { lines: narrationLines, captioned },
    repairRounds: rounds,
    remaining: assembled.drafts.flatMap((d) => d.problems.map((problem) => ({ scene: d.scene.title ?? d.scene.id, problem }))),
  };
  emit({ type: 'adapt-done', report });
  return { markdown: assembled.markdown, diagnostics: assembled.diagnostics, report };
}

/** Reads a reply: its JSON, the off-panel marks code adds, and the problems code finds. */
function review(draft: Draft, script: StoryScript): Draft {
  let adaptation: SceneAdaptation;
  try {
    adaptation = JSON.parse(unfence(draft.reply)) as SceneAdaptation;
  } catch (error) {
    return { ...draft, adaptation: undefined, problems: [`The reply was not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  // Models write a single cast member as a string now and then: take either.
  const side = (value: unknown): string[] | undefined => (value == null ? undefined : Array.isArray(value) ? value.map(String) : [String(value)]);
  adaptation.pages = (adaptation.pages ?? []).map((p) => ({
    ...p,
    rows: Array.isArray(p.rows) ? p.rows.map(Number) : [],
    panels: (p.panels ?? []).map((panel) =>
      markOffPanel({ ...panel, left: side(panel.left), center: side(panel.center), right: side(panel.right), items: Array.isArray(panel.items) ? panel.items : [] }, draft.lines)
    ),
  }));
  return { ...draft, adaptation, problems: adaptationProblems(adaptation, draft.lines, script.cast) };
}

/** Assembles the scenes that parsed, checks the comic script, and sorts its errors back to their scenes. */
async function assembleAndCheck(meta: { title: string; story: string; style: string }, drafts: Draft[], script: StoryScript) {
  const ready = drafts.filter((d) => d.adaptation);
  const { markdown, firstPage } = assembleComic(meta, ready.map((d) => ({ adaptation: d.adaptation!, lines: d.lines })));
  const { diagnostics } = await parseComic(markdown, { path: 'comic.md', cast: script.cast });
  const pageStarts = [...markdown.matchAll(/^## Page (\d+)$/gm)].map((m) => ({ page: Number(m[1]), line: markdown.slice(0, m.index).split('\n').length }));
  const out = drafts.map((d) => ({ ...d, problems: [...d.problems] }));
  const assembledDrafts = out.filter((d) => d.adaptation);
  for (const diagnostic of diagnostics.filter((x) => x.severity === 'error')) {
    const page = [...pageStarts].reverse().find((p) => p.line <= (diagnostic.source?.line ?? 1))?.page ?? 1;
    let sceneIndex = 0;
    firstPage.forEach((first, i) => { if (first <= page) sceneIndex = i; });
    const draft = assembledDrafts[sceneIndex] ?? out[0]!;
    draft.problems.push(`Page ${page - firstPage[sceneIndex]! + 1} of the scene: ${diagnostic.message}`);
  }
  return { markdown, diagnostics, drafts: out };
}

function castList(script: StoryScript): string {
  const members = Object.values(script.cast);
  const drawn = members.filter((m) => m.look).map((m) => `- ${m.id}: ${m.look}`);
  const unseen = members.filter((m) => !m.look).map((m) => m.id);
  return `Cast you can draw:\n${drawn.join('\n')}${unseen.length ? `\nVoices nobody sees: ${unseen.join(', ')}.` : ''}`;
}

function lineList(lines: SceneLines): string {
  return [...lines].map(([id, l]) => `${id} ${l.narration ? 'narration' : l.speaker}${l.cue ? ` (${l.cue})` : ''}: ${l.display}`).join('\n');
}

function scenePrompt(script: StoryScript, scene: Scene, lines: SceneLines, previous?: Scene): string {
  const before = previous ? previous.segments.filter((s): s is Line => s.kind === 'line').slice(-3).map((l) => `${l.narration ? 'narration' : l.speaker}: ${l.display}`).join('\n') : '';
  return [
    `Story: ${script.meta.title}. The narrator is ${script.narrator}${script.cast[script.narrator]?.look ? ' (a character, telling it in the first person)' : ''}.`,
    castList(script),
    before ? `The scene before ends:\n${before}` : 'This is the first scene.',
    `Scene: ${scene.title ?? scene.id}\n${lineList(lines)}`,
  ].join('\n\n');
}

function repairPrompt(script: StoryScript, draft: Draft, all: Scene[]): string {
  return [
    scenePrompt(script, draft.scene, draft.lines, all[all.indexOf(draft.scene) - 1]),
    `Your previous JSON:\n${unfence(draft.reply)}`,
    `Problems to fix:\n- ${draft.problems.join('\n- ')}`,
  ].join('\n\n');
}

function unfence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
