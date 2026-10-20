import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import { findFfmpeg } from '../cut/align.js';
import { renderArgs } from '../cut/render/plan.js';
import { timeOnTimeline } from '../cut/render/range.js';
import { loadCutForRender, planLoadedRender, runRender } from '../cut/render/run.js';

/** `mdmedia cut render`: a cut file into an MP4 with ffmpeg. See docs/cut-render.md. */

/** The cut's name: its file stem without `.cut.json`. */
function cutName(cutPath: string): string {
  return path.basename(cutPath).replace(/\.cut\.json$|\.json$/, '');
}

/** The media root, as `mdmedia cut words` picks it: `--root`, else MDMEDIA_CUT_MEDIA_ROOT, else the cut's own. */
function mediaRootArg(root: string | undefined): string | undefined {
  const chosen = root ?? process.env.MDMEDIA_CUT_MEDIA_ROOT;
  return chosen === undefined || chosen === '' ? undefined : path.resolve(chosen);
}

function stamp(seconds: number): string {
  return String(Math.round(seconds * 1000) / 1000);
}

/** Where a render goes by default: `<media root>/renders/<name>[.<from>-<to>][.preview][.script-timing].mp4`. */
export function defaultRenderPath(root: string, name: string, options: { from?: number; to?: number; preview?: boolean; timing?: string }): string {
  const range = options.from !== undefined || options.to !== undefined ? `.${stamp(options.from ?? 0)}-${options.to === undefined ? 'end' : stamp(options.to)}` : '';
  return path.join(root, 'renders', `${name}${range}${options.preview ? '.preview' : ''}${options.timing === 'script' ? '.script-timing' : ''}.mp4`);
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export const cutRenderCommand = defineCommand({
  meta: {
    name: 'render',
    description: 'Render a cut file to an MP4 with ffmpeg (default: <media root>/renders/<name>.mp4)',
  },
  args: {
    cut: { type: 'positional', required: true, description: 'Path to a <name>.cut.json file' },
    out: { type: 'string', description: 'Output file (default <media root>/renders/<name>.mp4)' },
    from: { type: 'string', description: 'Render from this time: seconds, frames (f120) or an anchor (pat-0.5)' },
    to: { type: 'string', description: 'Render up to this time: seconds, frames or an anchor (pat.end+0.5, @end)' },
    preview: { type: 'boolean', default: false, description: 'A fast half-size render' },
    root: { type: 'string', description: "Media root (default MDMEDIA_CUT_MEDIA_ROOT, else the cut's media.root)" },
    crf: { type: 'string', description: 'x264 CRF (default 16, or 26 with --preview)' },
    preset: { type: 'string', description: 'x264 preset (default slow, or veryfast with --preview)' },
    timing: { type: 'string', default: 'cut', description: "cut (the cut's own frame times) or script (the CRT TV scripts' concat drift, to compare with their renders)" },
    print: { type: 'boolean', default: false, description: 'Print the ffmpeg command instead of running it' },
    force: { type: 'boolean', default: false, description: 'Overwrite an existing file outside the renders folder' },
  },
  async run({ args }) {
    try {
      const cutPath = path.resolve(args.cut);
      const ffmpeg = await findFfmpeg();
      const loaded = await loadCutForRender(cutPath, { root: mediaRootArg(args.root), ffmpeg });
      const { timeline } = loaded;
      const at = (flag: 'from' | 'to', value: string | undefined): number | undefined => {
        if (value === undefined) return undefined;
        const t = timeOnTimeline(timeline, value);
        if (t === null) throw new Error(`--${flag} "${value}" isn't a time, a frame count or an anchor in this cut`);
        return t;
      };
      const from = at('from', args.from);
      const to = at('to', args.to);
      let crf: number | undefined;
      if (args.crf !== undefined) {
        crf = Number(args.crf);
        if (!Number.isInteger(crf) || crf < 0 || crf > 51) throw new Error(`--crf must be a whole number from 0 to 51 (got "${args.crf}")`);
      }
      if (args.timing !== 'cut' && args.timing !== 'script') throw new Error(`--timing must be cut or script (got "${args.timing}")`);
      const timing = args.timing;
      const renders = path.join(loaded.root, 'renders');
      const output = args.out ? path.resolve(args.out) : defaultRenderPath(loaded.root, cutName(cutPath), { from, to, preview: args.preview, timing });
      const readsIt = [...loaded.media.keys()].some((file) => path.resolve(file) === output);
      if (readsIt) throw new Error(`${output} is one of the cut's own sources; render somewhere else`);
      const inRenders = output.startsWith(`${renders}${path.sep}`);
      if (!args.print && existsSync(output) && !inRenders && !args.force) {
        throw new Error(`${output} exists and isn't in ${renders}; pass --force to overwrite it`);
      }

      const planned = planLoadedRender(loaded, { output, from, to, preview: args.preview, crf, preset: args.preset, timing });
      if (!planned.ok) throw new Error(planned.errors.join('\n'));
      const { plan } = planned;
      for (const note of plan.notes) console.error(`note: ${note}`);
      if (args.print) {
        console.log([ffmpeg, ...renderArgs(plan)].map(shellQuote).join(' '));
        return;
      }

      const started = Date.now();
      const live = process.stderr.isTTY;
      await runRender(plan, {
        ffmpeg,
        onProgress: live
          ? ({ seconds, duration }) => process.stderr.write(`\rrendering ${Math.min(seconds, duration).toFixed(1)} / ${duration.toFixed(1)} s`)
          : undefined,
      });
      if (live) process.stderr.write('\r\x1b[K');
      const { width, height, fps } = plan.output;
      const range = plan.range.from > 0 || plan.range.to < timeline.length ? ` ${stamp(plan.range.from)}–${stamp(plan.range.to)} s of` : '';
      const shown = path.relative(process.cwd(), output) || output;
      console.log(`Rendered${range} ${cutName(cutPath)} (${plan.output.duration.toFixed(2)} s, ${width}x${height}, ${fps} fps) to ${shown} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.error(`mdmedia cut render: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
});
