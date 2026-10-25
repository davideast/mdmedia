import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { castDelivery, castOfCut, castReference } from '../../src/character/cast.js';
import { formatCharacterRef } from '../../src/character/character.js';
import { characterRoot, listCharacters, stillPath } from '../../src/character/files.js';
import { measureCut } from '../../src/cut/check.js';
import { loadCutForCheck, renderDialogue } from '../../src/cut/check-run.js';
import { readProductionManifest } from '../../src/production/manifest.js';

/**
 * The seeded characters (docs/characters) and the casts of the productions
 * they were measured from: every file parses, every measured line is a line
 * of its cut spoken by that character, and the cast's reference levels flag
 * Big Hal Take 5's broken lines but none of the approved ones.
 */

const REPO = path.resolve(import.meta.dir, '../..');
const DIR = path.join(REPO, 'docs/characters');
const MEDIA = path.join(os.homedir(), '.local/share/mdmedia/productions/crt-tv');
const hasMedia = existsSync(path.join(MEDIA, 'takes'));
const measuredIds = ['big-hal', 'buddy', 'chet', 'moose', 'rick'];
const regularsIds = ['regulars-dot', 'regulars-eddie', 'regulars-kenny', 'regulars-rita', 'regulars-walt'];

describe('the seeded characters', () => {
  it('retain the five measured characters and five unmeasured Regulars references', async () => {
    const all = await listCharacters(DIR);
    expect(all.map((c) => formatCharacterRef(c.character)).sort()).toEqual([...measuredIds, ...regularsIds].sort().map((id) => `${id}@1`));
    const measured = all.filter(({ character }) => measuredIds.includes(character.id));
    for (const { character } of measured) {
      expect(character.delivery.reference?.lines.length).toBeGreaterThan(4);
      expect(character.stills.length).toBeGreaterThan(0);
      expect(character.look.never.length).toBeGreaterThan(0);
    }
    const voices = Object.fromEntries(measured.map((c) => [c.character.id, c.character.voice.name ?? c.character.voice.provider]));
    expect(voices).toEqual({ 'big-hal': 'video-model', buddy: 'Bill - Wise, Mature, Balanced', chet: 'Eric', moose: 'Roger', rick: 'video-model' });
    for (const { character } of all.filter(({ character }) => regularsIds.includes(character.id))) {
      expect(character.stills.length).toBeGreaterThan(0);
      expect(character.media.root).toBe('~/.local/share/mdmedia/productions/crt-tv');
      expect(character.voice.provider).toBe('video-model');
      expect(character.delivery.reference).toBeNull();
    }
    expect(readdirSync(DIR).every((f) => f.endsWith('.character.json'))).toBe(true);
  });

  it("were measured from their own lines in their productions' cuts", async () => {
    const cuts = new Map<string, Awaited<ReturnType<typeof loadCutForCheck>> | null>();
    for (const { character } of (await listCharacters(DIR)).filter(({ character }) => measuredIds.includes(character.id))) {
      for (const line of character.delivery.reference!.lines) {
        if (!cuts.has(line.cut)) cuts.set(line.cut, await loadCutForCheck(path.join(REPO, line.cut)).catch(() => null));
        const loaded = cuts.get(line.cut);
        if (!loaded) continue; // media not on this machine
        const found = loaded.timeline.lines.find((l) => l.id === line.line);
        expect(found?.speaker).toBe(character.name);
        expect(found?.text).toBe(line.text);
      }
    }
  }, 60_000);

  it.skipIf(!hasMedia)('have their reference stills on disk', async () => {
    for (const { character } of await listCharacters(DIR)) {
      expect(characterRoot(character)).toBe(MEDIA);
      for (const still of character.stills) expect(existsSync(stillPath(character, still.file))).toBe(true);
    }
  });
});

describe('casts', () => {
  it('are on Big Hal, Night Wagon: The Argument and CGL Football, and each cut finds its own', async () => {
    const casts = Object.fromEntries(await Promise.all(['big-hal', 'night-wagon-the-argument', 'football'].map(async (slug) => {
      const m = await readProductionManifest(path.join(REPO, 'docs/productions', `${slug}.production.json`));
      return [slug, m.cast.map((c) => `${c.role}=${formatCharacterRef(c.character)}`)];
    })));
    expect(casts).toEqual({ 'big-hal': ['Big Hal=big-hal@1'], 'night-wagon-the-argument': ['Rick=rick@1', 'Buddy=buddy@1'], football: ['Chet=chet@1', 'Moose=moose@1'] });
    const take7 = await castOfCut(path.join(REPO, 'docs/cuts/big-hal-take7.cut.json'));
    expect(take7?.manifest).toBe(path.join(REPO, 'docs/productions/big-hal.production.json'));
    expect(take7?.members.map((m) => m.role)).toEqual(['Big Hal']);
    expect(castReference(take7!.members)('Big Hal')?.source).toBe('big-hal@1, from 6 approved lines');
    expect(castReference(take7!.members)('Walt')).toBeUndefined();
    expect(castDelivery(take7!.members)('Big Hal')?.never).toContain('never shouts');
  });

  it.skipIf(!hasMedia)("flag Take 5's broken lines against Big Hal's reference, and none of the approved ones", async () => {
    const flagged = async (cut: string) => {
      const file = path.join(REPO, 'docs/cuts', cut);
      const cast = await castOfCut(file);
      const loaded = await loadCutForCheck(file);
      const pcm = await renderDialogue(loaded);
      const m = measureCut(loaded.timeline, { audio: { samples: pcm.samples, sampleRate: pcm.sampleRate }, start: pcm.start }, { reference: castReference(cast!.members) });
      return m.lines.filter((l) => l.flags.some((f) => f.code === 'outside-reference')).map((l) => l.id);
    };
    const take5 = await flagged('big-hal-take5.cut.json');
    expect(take5).toEqual(expect.arrayContaining(['personally', 'wheels']));
    const take6 = await flagged('big-hal-take6.cut.json');
    for (const approved of ['howdy', 'nomoney', 'zero', 'month', 'thisone', 'comeon']) expect(take6).not.toContain(approved);
  }, 120_000);
});
