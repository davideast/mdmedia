import { limiter } from '../limit.js';
import { parseStory } from '../parse.js';
import type { TextModel } from '../ports.js';
import type { Diagnostic, Line, StoryScript } from '../types.js';
import { applyDramatization, assembleStory, sceneHeadingLines, type CastPlan, type SceneDraft } from './assemble.js';
import { fidelity, type AddedSpan, type MissingSpan } from './fidelity.js';
import { CAST_INSTRUCTION, MAX_DRAMATIZED_WORDS, REPAIR_INSTRUCTION, SCENE_INSTRUCTION } from './prompts.js';
import { isVoice } from './voices.js';

export const MAX_REPAIR_ROUNDS = 2;

export interface Problem {
  scene: string;
  kind: 'error' | 'missing-cue' | 'cut' | 'unmarked-addition';
  detail: string;
}

export interface DirectReport {
  cast: CastPlan;
  scenes: number;
  lines: number;
  /** Lines the director added, marked in the file. */
  additions: string[];
  /** Author's sentences the director replaced with an added line, recorded in the file. */
  replaced: string[];
  repairRounds: number;
  /** Problems still in the file after the last repair round. */
  remaining: Problem[];
}

export type DirectEvent =
  | { type: 'cast-done'; cast: CastPlan }
  | { type: 'scene-done'; title: string }
  | { type: 'repair'; round: number; scenes: string[] }
  | { type: 'direct-done'; report: DirectReport };

export interface DirectResult {
  markdown: string;
  diagnostics: Diagnostic[];
  report: DirectReport;
}

/**
 * The director: turns an author's raw text into a story file. A cast pass
 * reads the whole story; a scene pass writes each scene; code assembles,
 * checks (story check, missing cues, fidelity to the author's words) and sends
 * each scene's problems back, up to MAX_REPAIR_ROUNDS times.
 */
export async function directStory(
  raw: string,
  options: { writer: TextModel; concurrency?: number; signal?: AbortSignal; onEvent?: (event: DirectEvent) => void }
): Promise<DirectResult> {
  const { writer, signal } = options;
  const emit = options.onEvent ?? (() => {});

  const plan = await castPass(raw, writer, signal);
  emit({ type: 'cast-done', cast: plan });
  const texts = sceneTexts(raw, plan);

  const limit = limiter(options.concurrency ?? 3);
  let drafts: SceneDraft[] = await Promise.all(
    plan.scenes.map((scene, i) =>
      limit(async () => {
        const body = await writer.generate({ system: SCENE_INSTRUCTION, prompt: scenePrompt(plan, texts[i]!, i > 0 ? texts[i - 1]! : ''), signal });
        emit({ type: 'scene-done', title: scene.title });
        return { title: scene.title, music: scene.music, body: dramatize(unfence(body), plan, texts[i]!) };
      })
    )
  );

  let markdown = assembleStory(plan, drafts);
  let checked = await check(raw, markdown, texts);
  let rounds = 0;
  while (checked.problems.length && rounds < MAX_REPAIR_ROUNDS) {
    rounds++;
    const byScene = new Map<number, Problem[]>();
    for (const p of checked.problems) {
      const i = plan.scenes.findIndex((s) => s.title === p.scene);
      byScene.set(i, [...(byScene.get(i) ?? []), p]);
    }
    emit({ type: 'repair', round: rounds, scenes: [...byScene.keys()].map((i) => plan.scenes[i]?.title ?? 'story') });
    drafts = await Promise.all(
      drafts.map((draft, i) => {
        const problems = byScene.get(i);
        if (!problems) return draft;
        return limit(async () => ({
          ...draft,
          body: dramatize(unfence(await writer.generate({ system: REPAIR_INSTRUCTION, prompt: repairPrompt(plan, texts[i]!, draft.body, problems), signal })), plan, texts[i]!),
        }));
      })
    );
    markdown = assembleStory(plan, drafts);
    checked = await check(raw, markdown, texts);
  }

  const lines = checked.script ? allLines(checked.script) : [];
  const report: DirectReport = {
    cast: plan,
    scenes: plan.scenes.length,
    lines: lines.length,
    additions: checked.added.filter((a) => a.allowed).map((a) => lines.find((l) => l.id === a.lineId)?.display ?? a.words.join(' ')),
    replaced: [...markdown.matchAll(/<!--\s*replaced:\s*"(.*)"[^"\n]*-->/g)].map((m) => m[1]!),
    repairRounds: rounds,
    remaining: checked.problems,
  };
  emit({ type: 'direct-done', report });
  return { markdown, diagnostics: checked.diagnostics, report };
}

/** The cast pass, with one retry when its JSON or choices are not usable. */
async function castPass(raw: string, writer: TextModel, signal?: AbortSignal): Promise<CastPlan> {
  let prompt = `The story:\n\n${raw}`;
  for (let attempt = 0; ; attempt++) {
    const reply = await writer.generate({ system: CAST_INSTRUCTION, prompt, json: true, signal });
    let plan: CastPlan | undefined;
    let problems: string[];
    try {
      plan = JSON.parse(unfence(reply)) as CastPlan;
      plan.names ??= [];
      problems = validatePlan(plan, raw);
    } catch (error) {
      problems = [`The reply was not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (!problems.length) return plan!;
    if (attempt >= 1) throw new Error(`The cast pass failed: ${problems.join(' ')}`);
    prompt = `The story:\n\n${raw}\n\nYour previous answer had these problems; fix them:\n- ${problems.join('\n- ')}`;
  }
}

/** Applies the cast pass's dramatizations that fall in this scene, once each. */
function dramatize(body: string, plan: CastPlan, sceneText: string): string {
  let out = body;
  for (const d of plan.dramatize ?? []) {
    if (!sceneText.includes(d.sentence) || out.includes(`<!-- replaced: "${d.sentence}" -->`)) continue;
    out = applyDramatization(out, d);
  }
  return out;
}

export function validatePlan(plan: CastPlan, raw: string): string[] {
  const problems: string[] = [];
  if (!plan.title) problems.push('There is no title.');
  const ids = Object.keys(plan.cast ?? {});
  if (!ids.length) problems.push('The cast is empty.');
  for (const id of ids) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(id)) problems.push(`Cast id ${id} must be capital letters.`);
    if (!isVoice(plan.cast[id]!.voice)) problems.push(`${id}'s voice "${plan.cast[id]!.voice}" is not one of the Gemini voices.`);
  }
  if (plan.narrator && 'character' in plan.narrator) {
    if (!plan.cast?.[plan.narrator.character]) problems.push(`The narrator ${plan.narrator.character} is not in the cast.`);
  } else if (!plan.narrator || !isVoice(plan.narrator.voice)) {
    problems.push('The narrator needs a character or a Gemini voice.');
  }
  if (!plan.scenes?.length) problems.push('There are no scenes.');
  for (const scene of plan.scenes ?? []) {
    if (findStart(raw, scene.firstWords) < 0) problems.push(`The scene "${scene.title}" starts with words not found in the story: "${scene.firstWords}".`);
  }
  for (const d of plan.dramatize ?? []) {
    if (!raw.includes(d.sentence)) problems.push(`The sentence to dramatize is not in the story word for word: "${d.sentence}".`);
    if (!plan.cast?.[d.speaker]) problems.push(`The speaker ${d.speaker} for "${d.line}" is not in the cast.`);
    const count = d.line.trim().split(/\s+/).length;
    if (count > MAX_DRAMATIZED_WORDS) problems.push(`The line "${d.line}" has ${count} words; a dramatized line is a punchline of at most ${MAX_DRAMATIZED_WORDS} words, with no reason given.`);
  }
  return problems;
}

/** Each scene's slice of the author's text; anything before the first scene goes with it. */
export function sceneTexts(raw: string, plan: CastPlan): string[] {
  const starts = plan.scenes.map((s) => findStart(raw, s.firstWords));
  return starts.map((start, i) => raw.slice(i === 0 ? 0 : start, i + 1 < starts.length ? starts[i + 1] : raw.length).trim());
}

/** Finds `firstWords` in the raw text, ignoring differences in spacing and quote marks. */
function findStart(raw: string, firstWords: string): number {
  const exact = raw.indexOf(firstWords);
  if (exact >= 0) return exact;
  const pattern = firstWords
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/["“”]/g, '["“”]').replace(/['‘’]/g, "['‘’]"))
    .join('\\s+');
  const match = new RegExp(pattern).exec(raw);
  return match ? match.index : -1;
}

function scenePrompt(plan: CastPlan, text: string, previous: string): string {
  const narrator = 'character' in plan.narrator ? `${plan.narrator.character} narrates (the story is in the first person).` : 'NARRATOR narrates.';
  const cast = Object.entries(plan.cast).map(([id, m]) => `- ${id}: ${m.delivery}`).join('\n');
  return [
    `Cast ids you may use:\n${cast}`,
    narrator,
    previous ? `The scene before this one ends with:\n${previous.slice(-600)}` : 'This is the first scene.',
    `The author's text for this scene:\n\n${text}`,
  ].join('\n\n');
}

function repairPrompt(plan: CastPlan, text: string, body: string, problems: Problem[]): string {
  return [
    scenePrompt(plan, text, ''),
    `Your current notation for this scene:\n\n${body}`,
    `Problems to fix:\n${problems.map((p) => `- ${p.detail}`).join('\n')}`,
  ].join('\n\n');
}

interface Checked {
  script?: StoryScript;
  diagnostics: Diagnostic[];
  added: AddedSpan[];
  problems: Problem[];
}

/** Parses and checks an assembled story, and names each problem's scene. */
async function check(raw: string, markdown: string, texts: string[]): Promise<Checked> {
  const { script, diagnostics } = await parseStory(markdown, { path: 'story.md' });
  const headings = sceneHeadingLines(markdown);
  const titles = markdown.split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4).trim());
  const sceneAt = (row: number) => titles[Math.max(0, headings.filter((h) => h <= row).length - 1)] ?? titles[0] ?? 'story';
  const problems: Problem[] = [];

  for (const d of diagnostics) {
    const row = d.source?.line ?? 1;
    const lineText = markdown.split('\n')[row - 1]?.trim() ?? '';
    if (d.code === 'missing-cue') problems.push({ scene: sceneAt(row), kind: 'missing-cue', detail: `This line has no cue; add one: ${lineText}` });
    else if (d.severity === 'error') problems.push({ scene: sceneAt(row), kind: 'error', detail: `${d.message} (at: ${lineText})` });
  }
  if (!script) return { diagnostics, added: [], problems };

  const f = fidelity(raw, markdown, script);
  const sceneOfParagraph = (paragraph: string) => {
    const i = texts.findIndex((t) => t.includes(paragraph));
    return titles[Math.max(0, i)] ?? 'story';
  };
  for (const gap of f.gaps) {
    if ('lineId' in gap) {
      const line = allLines(script).find((l) => l.id === gap.lineId);
      problems.push({
        scene: line ? sceneAt(line.source.line) : 'story',
        kind: 'unmarked-addition',
        detail: `These words are not in the author's text: "${gap.words.join(' ')}" (in the line: ${line?.display ?? ''}). Use the author's exact words, or if this is a deliberate added line, mark it with <!-- director: added -->.`,
      });
    } else {
      problems.push({
        scene: sceneOfParagraph((gap as MissingSpan).paragraph),
        kind: 'cut',
        detail: `The author's words "${gap.words.join(' ')}" are missing, from: "${(gap as MissingSpan).paragraph}". Put them back, word for word.`,
      });
    }
  }
  return { script, diagnostics, added: f.added, problems };
}

function allLines(script: StoryScript): Line[] {
  return script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
}

/** Strips a code fence a model may wrap its whole reply in. */
function unfence(text: string): string {
  // Only a plain or markdown fence: a scene may itself start and end with pause blocks.
  const match = /^\s*```(?:markdown|md|json)?\n([\s\S]*)\n```\s*$/.exec(text);
  return (match ? match[1]! : text).trim();
}
