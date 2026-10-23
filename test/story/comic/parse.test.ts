import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStory } from '../../../src/story/index.js';
import { parseComic } from '../../../src/story/comic/parse.js';
import type { ComicPanel } from '../../../src/story/comic/types.js';

const dir = join(import.meta.dir, '..', 'fixtures');
const comicMd = readFileSync(join(dir, 'comic-lunch.md'), 'utf8');
const cast = async () => (await parseStory(readFileSync(join(dir, 'embarrassing-day.md'), 'utf8'), { path: 's.md' })).script!.cast;
const panels = (pages: { panels: ComicPanel[] }[]) => pages.flatMap((p) => p.panels);

const tiny = (body: string, front = 'title: T\nstory: s.md\nstyle: flat') => `---\n${front}\n---\n\n${body}`;
const PANEL = '### Panel 1\n\n> A wide shot. Center: JUNE. Balloons: top.\n\n**JUNE** *(calm)*: Hi.\n';

describe('parseComic', () => {
  it('matches its golden comic.json', async () => {
    const { comic, diagnostics } = await parseComic(comicMd, { path: 'comic-lunch.md', cast: await cast() });
    expect(diagnostics).toEqual([]);
    const golden = join(import.meta.dir, '..', 'golden', 'comic-lunch.comic.json');
    const actual = JSON.stringify(comic, null, 2) + '\n';
    if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, actual);
    expect(actual).toBe(readFileSync(golden, 'utf8'));
  });

  it('lays out 21 panels on 4 pages with the prototype shapes', async () => {
    const { comic } = await parseComic(comicMd, { path: 'c.md', cast: await cast() });
    const all = panels(comic!.pages);
    expect(all).toHaveLength(21);
    expect(all.filter((p) => p.aspect === '16:9').map((p) => p.id)).toEqual(['1.1', '2.3', '3.6', '4.1']);
    expect(all.filter((p) => p.aspect === '2:3').map((p) => p.id)).toEqual(['3.1', '3.2', '3.3']);
  });

  it('reads acting notes, positions, edit chains and page staging', async () => {
    const { comic } = await parseComic(comicMd, { path: 'c.md', cast: await cast() });
    const byId = new Map(panels(comic!.pages).map((p) => [p.id, p]));
    expect(byId.get('3.4')!.positions).toEqual({ JUNE: 'left', MILO: 'right' });
    expect(byId.get('3.4')!.shot).toBe('June pulls back from the table; Milo raises both palms.');
    expect(byId.get('3.4')!.acting).toStartWith('June has just understood he betrayed her trust.');
    expect(byId.get('3.2')!.continues).toBe('3.1');
    expect(byId.get('3.3')!.continues).toBe('3.2');
    expect(byId.get('2.5')!.staging).toBeUndefined();
    expect(byId.get('3.1')!.staging).toStartWith('Side view across one cafeteria lunch table');
    expect(byId.get('4.1')!.rules).toBe('Whenever both are in a panel, June is on the left of the frame and Milo on the right.');
  });

  it('reads a balloon cue and its lettering mark separately', async () => {
    const { comic } = await parseComic(comicMd, { path: 'c.md', cast: await cast() });
    const item = panels(comic!.pages).find((p) => p.id === '4.4')!.items[1]!;
    expect(item).toMatchObject({ kind: 'balloon', who: 'JUNE', cue: 'barely holding it together, almost a whisper', mark: 'small', text: 'I guess that was stupid.' });
    const sfx = panels(comic!.pages).find((p) => p.id === '1.3')!.items[1]!;
    expect(sfx).toMatchObject({ kind: 'sfx', text: 'KAFF!' });
  });

  it('reports a layout that does not match the panels', async () => {
    const { diagnostics } = await parseComic(tiny(`## Page 1\n\nlayout: 1 1\n\n${PANEL}`), { path: 't.md' });
    expect(diagnostics.map((d) => d.code)).toEqual(['layout-mismatch']);
  });

  it('lets one panel replace the page setting for itself only', async () => {
    const md = tiny(
      `## Page 1\n\nlayout: 1 1\nsetting: a train roof\n\n### Panel 1\n\n> A. Center: JUNE.\n\n*(calm)* x\n\n` +
        `### Panel 2\n\nsetting: an empty platform\n  at sunrise\n\n> B. Center: JUNE.\n\n*(calm)* y\n`
    );
    const { comic } = await parseComic(md, { path: 't.md' });
    expect(panels(comic!.pages).map((p) => p.setting)).toEqual(['a train roof', 'an empty platform at sunrise']);
  });

  it('reports a continue to a later or missing panel', async () => {
    const md = tiny(`## Page 1\n\nlayout: 1 1\n\n### Panel 1\n\ncontinue: 1.2\n\n> A. Center: JUNE.\n\n*(calm)* x\n\n### Panel 2\n\n> B. Center: JUNE.\n\n*(calm)* y\n`);
    const { diagnostics } = await parseComic(md, { path: 't.md' });
    expect(diagnostics.map((d) => d.code)).toEqual(['bad-continue']);
  });

  it('reports unknown speakers in balloons and positions', async () => {
    const md = tiny(`## Page 1\n\nlayout: 1\n\n### Panel 1\n\n> A. Left: ZED.\n\n**ZED** *(calm)*: Hi.\n`);
    const { diagnostics } = await parseComic(md, { path: 't.md', cast: await cast() });
    expect(diagnostics.map((d) => d.code)).toEqual(['unknown-speaker', 'unknown-speaker']);
  });

  it('requires the front matter fields and an art note', async () => {
    expect((await parseComic(tiny(`## Page 1\n\nlayout: 1\n\n${PANEL}`, 'title: T'), { path: 't.md' })).diagnostics.map((d) => d.code)).toEqual(['missing-field', 'missing-field']);
    const noNote = tiny(`## Page 1\n\nlayout: 1\n\n### Panel 1\n\n*(calm)* Just words.\n`);
    expect((await parseComic(noNote, { path: 't.md' })).diagnostics.map((d) => d.code)).toEqual(['missing-field']);
    expect((await parseComic('# no front matter', { path: 't.md' })).diagnostics.map((d) => d.code)).toEqual(['missing-front-matter']);
  });

  it('warns on captions and balloons without a cue', async () => {
    const md = tiny(`## Page 1\n\nlayout: 1\n\n### Panel 1\n\n> A. Center: JUNE.\n\nPlain caption.\n\n**JUNE**: Hi.\n`);
    const { comic, diagnostics } = await parseComic(md, { path: 't.md' });
    expect(comic).toBeDefined();
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['missing-cue', 'warning'], ['missing-cue', 'warning']]);
  });
});
