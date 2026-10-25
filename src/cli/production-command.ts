import { defineCommand } from 'citty';
import { findFfmpeg } from '../cut/align.js';
import { readProductionManifest } from '../production/manifest.js';
import { describePush, describeTotals, pushProduction, type PushReport } from '../production/push.js';
import { ffmpegPosters, ffmpegThumbs } from '../production/thumbs.js';
import { cutMediaRootArg } from './cut-command.js';
import { connectedClient, guarded } from './studio-support.js';

const push = defineCommand({
  meta: {
    name: 'push',
    description: 'Push productions to your connected studio: upload their media once each (by hash), then replace their cuts, keeping statuses set in Studio. Safe to run again.',
  },
  args: {
    manifest: { type: 'positional', required: true, description: 'A <slug>.production.json (more may follow)' },
    root: { type: 'string', description: "Media root (default MDMEDIA_CUT_MEDIA_ROOT, else the manifest's media.root)" },
    thumbs: { type: 'boolean', default: true, description: 'Make and upload segment thumbnails and cut posters with ffmpeg (--no-thumbs to skip)' },
    'reset-status': {
      type: 'boolean',
      default: false,
      description: "Set every cut's status, and the approved and current cut, from the manifest, overriding reviews made in Studio (by default a status is set only on a cut the push creates)",
    },
    json: { type: 'boolean', description: 'Print the reports as JSON' },
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const files = [args.manifest, ...args._.slice(1)];
      const manifests = [];
      // Every manifest is checked before anything is sent.
      for (const file of files) manifests.push(await readProductionManifest(file, { root: cutMediaRootArg(args.root) }));
      const client = connectedClient();
      const ffmpeg = args.thumbs ? await findFfmpeg() : null;
      const thumbs = ffmpeg ? ffmpegThumbs(ffmpeg) : null;
      const posters = ffmpeg ? ffmpegPosters(ffmpeg) : null;
      const reports: PushReport[] = [];
      for (const manifest of manifests) {
        const report = await pushProduction(client, manifest, {
          thumbs,
          posters,
          resetStatus: args['reset-status'],
          log: args.json ? undefined : (line) => console.error(line),
        });
        reports.push(report);
        if (!args.json) console.log(describePush(report));
      }
      if (args.json) console.log(JSON.stringify({ reports }, null, 2));
      else if (reports.length > 1) console.log(describeTotals(reports));
    });
  },
});

export const productionCommand = defineCommand({
  meta: { name: 'production', description: 'Work with productions: episodes and commercials, and their cuts, in your studio' },
  subCommands: { push },
});
