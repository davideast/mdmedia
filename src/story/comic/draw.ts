import { RENDER_VERSION } from '../key.js';
import { limiter } from '../limit.js';
import { sha256 } from '../parse.js';
import type { ImageBytes, ImageModel, RenderCache, Vision } from '../ports.js';
import type { CastMember } from '../types.js';
import {
  NO_TEXT_QUESTION,
  sidesQuestion,
  visualLook,
  namedIn,
  onModelQuestions,
  panelPrompt,
  panelQuestions,
  sheetPrompt,
  stagingPrompt,
  type Reference,
} from './prompts.js';
import type { ComicPanel, ComicScript } from './types.js';

/** Redraws after the first take when a check fails. */
export const MAX_REDRAWS = 2;
/** Tries for a staging image to come out on model before panels use it. */
export const STAGING_TRIES = 3;

export interface Checked {
  key: string;
  cached: boolean;
  attempts: number;
  questions: string[];
  answers: boolean[];
  ok: boolean;
  /** Approved and locked: used as it is, never re-checked or redrawn. */
  locked?: boolean;
}

export interface PanelResult extends Checked {
  id: string;
  references: string[];
  heads: Array<{ id: string; box: [number, number, number, number] }>;
}

export interface StagingResult extends Checked {
  index: number;
  text: string;
}

export interface DrawResult {
  sheet: { key: string; cached: boolean };
  stagings: StagingResult[];
  panels: PanelResult[];
  /** Every final image: `sheet`, `staging-1`, …, and panel ids. */
  images: Map<string, ImageBytes>;
}

export type DrawEvent =
  | { type: 'sheet-done'; cached: boolean }
  | { type: 'staging-done'; result: StagingResult }
  | { type: 'panel-done'; result: PanelResult };

export interface DrawOptions {
  image: ImageModel;
  vision: Vision;
  cache: RenderCache;
  /** Pages drawn at once; panels within a page go in order. */
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: DrawEvent) => void;
  /** Draw again images that failed their checks in an earlier build, instead of reusing their best take. */
  redraw?: boolean;
  /**
   * Approved panel images by panel id. A locked panel is used as it is: it is
   * never re-checked or redrawn, whatever the checks, prompts or cache say.
   */
  locked?: Map<string, ImageBytes>;
}

/**
 * Draws a comic script: the character sheet, each staging image (checked on
 * model before anything is drawn from it), then every panel with its
 * references, checked with generated yes/no questions and redrawn up to
 * MAX_REDRAWS times. A `continue` panel is an edit of the panel it continues.
 * Finally, head boxes for every panel, for lettering.
 */
export async function drawComic(comic: ComicScript, cast: Record<string, CastMember>, options: DrawOptions): Promise<DrawResult> {
  const { image, vision, cache, signal } = options;
  const emit = options.onEvent ?? (() => {});
  const images = new Map<string, ImageBytes>();
  const keys = new Map<string, string>();
  const style = comic.meta.style;

  const locked = options.locked ?? new Map<string, ImageBytes>();
  const toDraw = comic.pages.flatMap((p) => p.panels).filter((p) => !locked.has(p.id));

  // 1. The character sheet (only when a panel will be drawn).
  const sheetText = sheetPrompt(style, cast);
  const sheetKey = await imageKey(image.model, sheetText, [], '16:9');
  let sheet = await cache.getImage(sheetKey);
  const sheetCached = Boolean(sheet) || !toDraw.length;
  if (!sheet && toDraw.length) {
    const drawn = await image.draw({ prompt: sheetText, references: [], aspectRatio: '16:9', signal });
    sheet = { ...drawn, meta: { kind: 'sheet' } };
    await cache.putImage(sheetKey, sheet);
  }
  if (sheet) images.set('sheet', sheet);
  keys.set('sheet', sheetKey);
  emit({ type: 'sheet-done', cached: sheetCached });

  // 2. Staging images, one per distinct staging text, checked on model.
  const panels = comic.pages.flatMap((p) => p.panels);
  const stagingTexts = [...new Set(panels.map((p) => p.staging).filter((s): s is string => Boolean(s)))];
  // A staging nothing unlocked is drawn from is not drawn.
  const neededStagings = new Set(toDraw.map((p) => p.staging).filter(Boolean));
  const stagings: StagingResult[] = [];
  for (const [i, text] of stagingTexts.entries()) {
    if (!neededStagings.has(text)) continue;
    const ids = namedIn(text, cast);
    const using = panels.filter((p) => p.staging === text);
    const placement = stagingPlacement(using, ids);
    const prompt = stagingPrompt(style, text, cast, ids, placement, using[0]?.rules);
    const sides = sidesQuestion(placement);
    const questions = [...onModelQuestions(ids, cast), NO_TEXT_QUESTION, ...(sides ? [sides] : [])];
    const checked = await drawChecked({
      key: await imageKey(image.model, prompt, [sheetKey], '16:9'),
      tries: STAGING_TRIES,
      draw: () => image.draw({ prompt, references: [sheet!], aspectRatio: '16:9', signal }),
      check: (img) => vision.ask({ images: [{ label: 'Image to check', ...img }], questions, signal }),
      questions,
      cache,
      redraw: options.redraw,
    });
    images.set(`staging-${i + 1}`, checked.image);
    keys.set(`staging-${i + 1}`, checked.result.key);
    const result: StagingResult = { ...checked.result, index: i + 1, text };
    stagings.push(result);
    emit({ type: 'staging-done', result });
  }
  const stagingName = (panel: ComicPanel) => (panel.staging ? `staging-${stagingTexts.indexOf(panel.staging) + 1}` : undefined);

  // 3. Panels: pages in parallel, panels within a page in order. A page that
  // keeps the staging of the page before waits for its last panel and takes it
  // as a reference, so a scene doesn't lose its room at a page turn.
  const done = new Map<string, Promise<void>>();
  const finished = new Map<string, () => void>();
  for (const p of panels) done.set(p.id, new Promise((resolve) => finished.set(p.id, resolve)));
  const results = new Map<string, PanelResult>();
  const limit = limiter(options.concurrency ?? 2);

  await Promise.all(
    comic.pages.map((page) =>
      limit(async () => {
        for (const [i, panel] of page.panels.entries()) {
          const lastOfPagePrior = comic.pages[comic.pages.indexOf(page) - 1]?.panels.at(-1);
          const previous = i > 0 ? page.panels[i - 1] : lastOfPagePrior && panel.staging && lastOfPagePrior.staging === panel.staging ? lastOfPagePrior : undefined;
          if (previous && i === 0) await done.get(previous.id);
          let refs: Array<{ name: string; label: Reference | 'source' }>;
          if (panel.continues) {
            await done.get(panel.continues);
            refs = [{ name: panel.continues, label: 'source' }];
          } else {
            refs = [{ name: 'sheet', label: 'sheet' }];
            const staging = stagingName(panel);
            if (staging) refs.push({ name: staging, label: 'staging' });
            if (previous) refs.push({ name: previous.id, label: 'previous' });
          }
          const prompt = panelPrompt(panel, style, cast, refs.filter((r) => r.label !== 'source').map((r) => r.label as Reference), previous);
          const questions = panelQuestions(panel, cast);
          const references = refs.map((r) => images.get(r.name)!);
          const source = panel.continues ? images.get(panel.continues) : undefined;
          const lockedImage = locked.get(panel.id);
          const checked = lockedImage
            ? {
                image: lockedImage,
                result: { key: `locked:${await bytesHash(lockedImage.bytes)}`, cached: true, attempts: 0, questions, answers: questions.map(() => true), ok: true, locked: true },
              }
            : await drawChecked({
            key: await imageKey(image.model, prompt, refs.map((r) => keys.get(r.name)!), panel.aspect),
            tries: 1 + MAX_REDRAWS,
            draw: () => image.draw({ prompt, references, aspectRatio: panel.aspect, signal }),
            check: (img) =>
              vision.ask({
                images: [...(source ? [{ label: 'Previous panel', ...source }] : []), { label: 'Panel to check', ...img }],
                questions,
                signal,
              }),
                questions,
                cache,
                redraw: options.redraw,
              });
          if (lockedImage) refs.length = 0;
          images.set(panel.id, checked.image);
          keys.set(panel.id, checked.result.key);
          const heads = await headBoxes(panel, checked.image, checked.result.key, cast, vision, cache, signal);
          const result: PanelResult = { ...checked.result, id: panel.id, references: refs.map((r) => r.name), heads };
          results.set(panel.id, result);
          finished.get(panel.id)!();
          emit({ type: 'panel-done', result });
        }
      })
    )
  );

  return { sheet: { key: sheetKey, cached: sheetCached }, stagings, panels: panels.map((p) => results.get(p.id)!), images };
}

/**
 * Draws until every check passes or the tries run out, keeping the take with
 * the most yes answers. A take that still fails is cached as not accepted and
 * reused by later builds, so its art doesn't change every run; pass `redraw`
 * to try again. A cached image checked with other questions is checked again
 * before anything is redrawn.
 */
async function drawChecked(args: {
  key: string;
  tries: number;
  draw: () => Promise<ImageBytes>;
  check: (image: ImageBytes) => Promise<boolean[]>;
  questions: string[];
  cache: RenderCache;
  redraw?: boolean;
}): Promise<{ image: ImageBytes; result: Checked }> {
  const hit = await args.cache.getImage(args.key);
  const sameQuestions = JSON.stringify(hit?.meta.questions) === JSON.stringify(args.questions);
  if (hit && sameQuestions && (hit.meta.accepted || !args.redraw)) {
    const answers = hit.meta.answers as boolean[];
    return { image: hit, result: { key: args.key, cached: true, attempts: 0, questions: args.questions, answers, ok: Boolean(hit.meta.accepted) } };
  }
  let best: { image: ImageBytes; answers: boolean[] } | undefined;
  if (hit?.meta.accepted) {
    const image = { bytes: hit.bytes, mimeType: hit.mimeType };
    const answers = await args.check(image);
    if (answers.every(Boolean)) {
      await args.cache.putImage(args.key, { ...image, meta: { questions: args.questions, answers, accepted: true } });
      return { image, result: { key: args.key, cached: true, attempts: 0, questions: args.questions, answers, ok: true } };
    }
    best = { image, answers };
  }
  let attempts = 0;
  while (attempts < args.tries) {
    attempts++;
    const image = await args.draw();
    const answers = await args.check(image);
    if (!best || yes(answers) > yes(best.answers)) best = { image, answers };
    if (answers.every(Boolean)) break;
  }
  const ok = best!.answers.every(Boolean);
  await args.cache.putImage(args.key, { ...best!.image, meta: { questions: args.questions, answers: best!.answers, accepted: ok } });
  return { image: best!.image, result: { key: args.key, cached: false, attempts, questions: args.questions, answers: best!.answers, ok } };
}

async function headBoxes(
  panel: ComicPanel,
  img: ImageBytes,
  panelKey: string,
  cast: Record<string, CastMember>,
  vision: Vision,
  cache: RenderCache,
  signal?: AbortSignal
): Promise<PanelResult['heads']> {
  const characters = Object.keys(panel.positions).filter((id) => cast[id]?.look).map((id) => ({ id, look: visualLook(cast[id]!.look!) }));
  if (!characters.length) return [];
  // Keyed by the image itself: a panel redrawn under the same key gets its own heads.
  const key = `heads:${await sha256(JSON.stringify([RENDER_VERSION, vision.model, panelKey, await bytesHash(img.bytes)]))}`;
  const hit = await cache.getImage(key);
  // An empty result from before empty answers were retried is asked again.
  if (hit && (hit.meta.heads as PanelResult['heads']).length) return hit.meta.heads as PanelResult['heads'];
  let heads: PanelResult['heads'];
  try {
    heads = await vision.heads({ image: img, characters, signal });
    // Nobody found where someone stands is usually a miss; ask once more.
    if (!heads.length) heads = await vision.heads({ image: img, characters, signal });
  } catch (error) {
    // Head boxes help lettering but aren't worth failing a build over: the
    // panel is reported without them and asked again next build.
    if (signal?.aborted) throw error;
    return [];
  }
  await cache.putImage(key, { bytes: new TextEncoder().encode(JSON.stringify(heads)), mimeType: 'application/json', meta: { heads } });
  return heads;
}

const yes = (answers: boolean[]) => answers.filter(Boolean).length;

/**
 * Where each staged character stands, from the panels drawn from this
 * staging: the side they take most often in panels where they appear with
 * someone else on the other side.
 */
export function stagingPlacement(panels: ComicPanel[], ids: string[]): Record<string, 'left' | 'right'> {
  const counts = new Map<string, { left: number; right: number }>();
  for (const panel of panels) {
    const sides = Object.entries(panel.positions).filter(([id, side]) => ids.includes(id) && side !== 'center');
    if (!sides.some(([, s]) => s === 'left') || !sides.some(([, s]) => s === 'right')) continue;
    for (const [id, side] of sides) {
      const c = counts.get(id) ?? { left: 0, right: 0 };
      c[side as 'left' | 'right']++;
      counts.set(id, c);
    }
  }
  const out: Record<string, 'left' | 'right'> = {};
  for (const [id, c] of counts) if (c.left !== c.right) out[id] = c.left > c.right ? 'left' : 'right';
  return out;
}

async function bytesHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function imageKey(model: string, prompt: string, references: string[], aspect: string): Promise<string> {
  return `image:${await sha256(JSON.stringify([RENDER_VERSION, model, prompt, references, aspect]))}`;
}
