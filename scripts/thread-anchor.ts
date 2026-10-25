/**
 * Prints the anchor for a playhead time on a cut, with each item's times as they are now, so a reply made at that
 * time can record what was under the playhead (and still make sense after the cut changes).
 *
 * Usage: bun scripts/thread-anchor.ts <cut-id> <seconds>
 * Prints: { "cutId", "time", "items": [ { "kind", "id", "start", "end" } ] }
 */
import path from 'node:path';
import os from 'node:os';
import { loadCutWithWords } from '../src/cut/align.js';
import { anchorItems, itemSpan } from '../src/threads/anchor.js';

const REPO = path.resolve(import.meta.dir, '..');
const MEDIA_ROOT = process.env.MDMEDIA_CUT_MEDIA_ROOT ?? path.join(os.homedir(), '.local/share/mdmedia/productions/crt-tv');
const [cutId, seconds] = process.argv.slice(2);
if (!cutId || !/^[a-z0-9-]+$/.test(cutId) || !Number.isFinite(Number(seconds))) {
  console.error('usage: bun scripts/thread-anchor.ts <cut-id> <seconds>');
  process.exit(2);
}
const time = Number(seconds);
const { timeline } = await loadCutWithWords(path.join(REPO, 'docs', 'cuts', `${cutId}.cut.json`), { root: MEDIA_ROOT });
const round = (n: number): number => Math.round(n * 1000) / 1000;
const items = anchorItems(timeline, time).map((ref) => {
  const span = itemSpan(timeline, ref);
  return span ? { ...ref, start: round(span.start), end: round(span.end) } : ref;
});
console.log(JSON.stringify({ cutId, time, items }));
