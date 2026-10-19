// Throwaway: writes a story file with one line per caption and balloon, in
// reading order, so render.ts can voice the comic in line mode. Cast and
// delivery cues come from the full story file, matched by text.
//
//   bun spikes/story/tools/comic-audio.ts <comic.json> <story.md> <out story.md>

import { readFileSync, writeFileSync } from 'node:fs';

const [comicPath, storyPath, outPath] = Bun.argv.slice(2);
if (!comicPath || !storyPath || !outPath) {
  console.error('usage: bun spikes/story/tools/comic-audio.ts <comic.json> <story.md> <out story.md>');
  process.exit(2);
}

interface Item { kind: string; who?: string; text: string }
const comic = JSON.parse(readFileSync(comicPath, 'utf8')) as { title: string; panels: Array<{ id: number; items: Item[] }> };
const story = readFileSync(storyPath, 'utf8');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(story)![1]!;

// Delivery cues from the story, keyed by speaker and normalized text.
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
const cues: Array<{ who: string; words: Set<string>; delivery: string }> = [];
for (const m of story.matchAll(/^\*\*([A-Z]+)\*\*\s*\*\(([^)]*)\)\*:\s*([\s\S]*?)(?=\n\n)/gm)) {
  cues.push({ who: m[1]!, delivery: m[2]!, words: new Set(words(m[3]!)) });
}
function cueFor(who: string, text: string): string {
  const w = words(text);
  let best = { score: 0, delivery: '' };
  for (const c of cues.filter((c) => c.who === who)) {
    const score = w.filter((x) => c.words.has(x)).length / Math.max(w.length, 1);
    if (score > best.score) best = { score, delivery: c.delivery };
  }
  return best.score >= 0.6 ? best.delivery : '';
}

const out: string[] = [`---\n${fm}\n---\n`, `# ${comic.title}\n`];
let n = 0;
for (const panel of comic.panels) {
  for (const item of panel.items) {
    if (item.kind === 'sfx') continue;
    n++;
    if (item.kind === 'caption') out.push(item.text + '\n');
    else {
      const cue = cueFor(item.who!, item.text);
      out.push(`**${item.who}**${cue ? ` *(${cue})*` : ''}: ${item.text}\n`);
    }
  }
}
writeFileSync(outPath, out.join('\n'));
console.log(`${n} lines -> ${outPath}`);
