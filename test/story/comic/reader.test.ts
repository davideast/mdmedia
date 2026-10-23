import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { buildComic } from '../../../src/story/comic/build.js';
import { lettering, letterPanel, type Measure } from '../../../src/story/comic/letter.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import { fakeImageModel, fakeVision, memoryCache, memorySink, passThroughRuntime, scriptedTranscriber, toneSpeaker } from '../fakes.js';

const dir = join(import.meta.dir, '..', 'fixtures');
const story = (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!;
const comic = (await parseComic(readFileSync(join(dir, 'comic-lunch.md'), 'utf8'), { path: 'c.md', cast: story.cast })).comic!;

const build = async (voices = true) => {
  const sink = memorySink();
  const result = await buildComic({
    comic,
    story,
    image: fakeImageModel(),
    vision: fakeVision(),
    cache: memoryCache(),
    runtime: passThroughRuntime,
    sink,
    ...(voices ? { speaker: toneSpeaker(), transcriber: scriptedTranscriber() } : {}),
  });
  return { sink, result };
};

describe('the reader', () => {
  it('writes one page, a WebP per panel and an MP3 per caption and balloon', async () => {
    const { sink, result } = await build();
    const files = [...sink.files.keys()];
    const voiced = comic.pages.flatMap((p) => p.panels.flatMap((panel) => panel.items.filter((i) => i.kind !== 'sfx'))).length;
    expect(files).toContain('reader/index.html');
    expect(files.filter((f) => f.startsWith('reader/img/'))).toHaveLength(21);
    expect(files.filter((f) => f.startsWith('reader/audio/'))).toHaveLength(voiced);
    expect(result.data.pages.map((p) => p.panels.length)).toEqual(comic.pages.map((p) => p.panels.length));
    const items = result.data.pages[0]!.panels[0]!.items;
    expect(items[0]).toMatchObject({ kind: 'caption', audio: 'audio/1-1-0.mp3' });
    expect(items[1]).toMatchObject({ kind: 'balloon', who: 'HARPER', text: 'Milo! Dude!' });
  });

  it('has no audio and no Read aloud without voices', async () => {
    const { sink } = await build(false);
    expect([...sink.files.keys()].some((f) => f.startsWith('reader/audio/'))).toBe(false);
    expect(String(sink.files.get('reader/index.html'))).not.toContain('aria-label="Read aloud"');
  });

  it('inlines a lettering source that runs on its own and lays out the same', () => {
    const inlined = new Function(`return (${lettering.toString()})();`)() as ReturnType<typeof lettering>;
    const measure: Measure = (t, px) => t.length * px * 0.6;
    const panel = comic.pages[1]!.panels[2]!;
    const heads = [{ id: 'MILO', box: [0.2, 0.15, 0.45, 0.3] as [number, number, number, number] }];
    expect(inlined.letterPanel(panel, heads, 400, 300, measure, { fontPx: 14 })).toEqual(letterPanel(panel, heads, 400, 300, measure, { fontPx: 14 }));
  });
});

/** Chromium's headless shell, from MDMEDIA_TEST_CHROME or a Playwright browser cache. */
function findChrome(): string | undefined {
  if (process.env.MDMEDIA_TEST_CHROME) return process.env.MDMEDIA_TEST_CHROME;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright')]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root).filter((n) => n.startsWith('chromium_headless_shell')).sort().reverse()) {
      const bin = join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const chrome = findChrome();
if (!chrome) console.log('Skipping the reader smoke test: no headless Chromium (set MDMEDIA_TEST_CHROME).');

describe.if(Boolean(chrome))('the reader in a browser', async () => {
  const { sink } = await build();
  const out = mkdtempSync(join(tmpdir(), 'story-reader-'));
  for (const [path, data] of sink.files) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), data);
  }
  const dom = (hash: string, width = 412, height = 915) =>
    spawnSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', `--window-size=${width},${height}`, '--virtual-time-budget=4000', '--dump-dom', `file://${join(out, 'reader', 'index.html')}${hash}`], {
      encoding: 'utf8',
      timeout: 60_000,
    }).stdout;

  it('letters every page in the page view', () => {
    const html = dom('');
    expect((html.match(/class="page"/g) ?? []).length).toBe(4);
    // Every caption and balloon is lettered, once.
    const voiced = comic.pages.flatMap((p) => p.panels.flatMap((panel) => panel.items.filter((i) => i.kind !== 'sfx'))).length;
    expect((html.match(/data-audio="audio\//g) ?? []).length).toBe(voiced);
    expect(html).toMatch(/MILO!(<br>| )DUDE!/);
  });

  it('opens the guided view on the panel in the hash', () => {
    const html = dom('#guided=3.4');
    expect(html).toContain('class="guided"');
    expect(html).toMatch(/<div id="stage"><div class="panel" data-id="3\.4"/);
    expect(html).toContain('Page 3, panel 4 of 6');
  });
});
