import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineCommand } from 'citty';
import { measureCut } from '../cut/check.js';
import { loadCutForCheck, renderDialogue } from '../cut/check-run.js';
import { lineSound } from '../cut/performance.js';
import { buildStoryboard } from '../cut/storyboard.js';
import type { Timeline } from '../cut/types.js';
import { castDelivery, castOfCut } from '../character/cast.js';
import { cutMediaRootArg } from './cut-root.js';

/** `mdmedia cut storyboard`: a shot's storyboard with its delivery context. See docs/cut-check.md. */

/** The storyboard the shot's current source was generated from, by its provenance, in `dir`. */
export function sourceStoryboard(timeline: Timeline, target: string, dir: string): string | null {
  const perf = timeline.performances.find((p) => p.id === target || p.lines.includes(target));
  const lineId = perf ? perf.lines[0] : target;
  const line = timeline.lines.find((l) => l.id === lineId);
  if (!line) return null;
  let ref = lineSound(line, timeline.segments, [...timeline.music, ...timeline.sfx]).ref;
  // A swapped take was generated as the take it was swapped from.
  for (let i = 0; ref !== null && i < 8; i++) {
    const from = timeline.sources[ref]?.swappedFrom;
    if (!from || !('ref' in from)) break;
    ref = from.ref;
  }
  const name = ref === null ? null : timeline.sources[ref]?.storyboard;
  if (!name) return null;
  const file = path.join(dir, `${name}.md`);
  return existsSync(file) ? file : null;
}

/** The cast roles a storyboard's text names, as whole words: who else is in the shot. */
export function castInText(roles: readonly string[], text: string): string[] {
  return roles.filter((role) => new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

/** A path relative to here when it is under here, else absolute. */
function shown(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

export const cutStoryboardCommand = defineCommand({
  meta: {
    name: 'storyboard',
    description: "Write a shot's storyboard with its delivery context: what was just said and how, its whole performance and direction, and what comes next",
  },
  args: {
    cut: { type: 'positional', required: true, description: 'Path to a <name>.cut.json file' },
    id: { type: 'positional', required: true, description: 'A line or performance id (a line brings its whole performance)' },
    out: { type: 'string', description: 'Write the storyboard here (default: print it)' },
    base: { type: 'string', description: "A storyboard to keep the look and framing paragraphs of (default: the one the shot's current take was generated from, if found)" },
    storyboards: { type: 'string', description: 'Where to find storyboards by name (default <media root>/review/storyboards)' },
    setting: { type: 'string', description: 'What the cut is, for "Where this sits in the …" (default: the base storyboard\'s, else "scene")' },
    root: { type: 'string', description: "Media root (default MDMEDIA_CUT_MEDIA_ROOT, else the cut's media.root)" },
    force: { type: 'boolean', default: false, description: 'Overwrite an existing --out file' },
    production: { type: 'string', description: "The production manifest whose cast gives the speaker's look, \"never\" rules and delivery profile (default: the one in docs/productions that lists this cut)" },
    cast: { type: 'boolean', default: true, description: "Write the cast's look and delivery profile into the storyboard (--no-cast to skip)" },
  },
  async run({ args }) {
    try {
      const loaded = await loadCutForCheck(path.resolve(args.cut), { root: cutMediaRootArg(args.root) });
      const { timeline } = loaded;
      const pcm = await renderDialogue(loaded);
      const measured = measureCut(timeline, { audio: { samples: pcm.samples, sampleRate: pcm.sampleRate }, start: pcm.start });
      const dir = args.storyboards ? path.resolve(args.storyboards) : path.join(loaded.root, 'review', 'storyboards');
      const basePath = args.base ? path.resolve(args.base) : sourceStoryboard(timeline, args.id, dir);
      const base = basePath ? await readFile(basePath, 'utf8') : null;
      const cast = args.cast ? await castOfCut(path.resolve(args.cut), { production: args.production }) : null;
      const result = buildStoryboard({
        timeline,
        target: args.id,
        measured,
        base,
        setting: args.setting,
        character: cast ? castDelivery(cast.members) : undefined,
        inShot: cast && base ? castInText(cast.members.map((m) => m.role), base) : undefined,
      });
      if (basePath) console.error(`note: look and framing from ${shown(basePath)}`);
      for (const note of result.notes) console.error(`note: ${note}`);
      if (args.out) {
        const out = path.resolve(args.out);
        if (existsSync(out) && !args.force) throw new Error(`${out} exists; pass --force to overwrite it`);
        await writeFile(out, result.markdown);
        console.error(`Wrote ${shown(out)}`);
      } else {
        process.stdout.write(result.markdown);
      }
    } catch (error) {
      console.error(`mdmedia cut storyboard: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});
