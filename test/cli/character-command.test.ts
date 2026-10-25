import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newCharacter, nextVersion, serializeCharacter } from '../../src/character/character.js';
import { archivedFile, charactersDir, currentFile, listCharacters, loadCharacter, readCharacterFile, stillPath, writeCharacter, writeNewVersion } from '../../src/character/files.js';
import { parseLineSelection } from '../../src/character/measure-run.js';
import { swapStem, swapVoice, type SwapReport } from '../../src/character/swap-run.js';
import { characterCommand, formatCharacter, formatSwap } from '../../src/cli/character-command.js';
import { resolveSmartCliArgv } from '../../src/cli/command.js';
import { findFfmpeg } from '../../src/cut/align.js';
import { runFfmpeg } from '../../src/cut/render/run.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-characters-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const walt = () => newCharacter({ id: 'walt', name: 'Walt', root: '/media', date: '2026-10-20' });

describe('mdmedia character', () => {
  it('has new, show, list, measure, still and swap, and the smart router leaves it alone', () => {
    const sub = (characterCommand as { subCommands?: Record<string, unknown> }).subCommands ?? {};
    expect(Object.keys(sub)).toEqual(['new', 'show', 'list', 'measure', 'still', 'swap']);
    expect(resolveSmartCliArgv(['character', 'swap', 'take.mp4', 'chet', '--out', 'x.mp4'])).toEqual(['character', 'swap', 'take.mp4', 'chet', '--out', 'x.mp4']);
  });

  it('finds the characters folder: the flag, the environment, else docs/characters in the repository', () => {
    expect(charactersDir({ dir: '/x/y' })).toBe('/x/y');
    expect(charactersDir({ env: { MDMEDIA_CHARACTERS_DIR: '/c' } })).toBe('/c');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git', 'x'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'productions'), { recursive: true });
    expect(charactersDir({ from: path.join(repo, 'docs', 'productions'), env: {} })).toBe(path.join(repo, 'docs', 'characters'));
  });

  it('writes a character once, then keeps each earlier version beside the current one', async () => {
    const chars = path.join(dir, 'chars');
    fs.mkdirSync(chars);
    await writeCharacter(chars, walt(), { create: true });
    await expect(writeCharacter(chars, walt(), { create: true })).rejects.toThrow('a character is created once');
    expect(fs.readFileSync(currentFile(chars, 'walt'), 'utf8')).toBe(serializeCharacter(walt()));

    const v2 = nextVersion({ ...walt(), description: 'Walt, who has never been here before.' }, 'A sharper description.', '2026-10-21');
    const { archived } = await writeNewVersion(chars, v2);
    expect(archived).toBe(archivedFile(chars, 'walt', 1));
    await expect(writeNewVersion(chars, v2)).rejects.toThrow('the next is 3');
    // An older version is never written over a newer one.
    await expect(writeCharacter(chars, walt())).rejects.toThrow("won't write version 1");

    expect((await loadCharacter(chars, 'walt')).character.version).toBe(2);
    expect((await loadCharacter(chars, 'walt@2')).file).toBe(currentFile(chars, 'walt'));
    expect((await loadCharacter(chars, 'walt@1')).character.description).toBe(walt().description);
    await expect(loadCharacter(chars, 'walt@3')).rejects.toThrow('No walt@3');
    await expect(loadCharacter(chars, 'Walt')).rejects.toThrow('is not a character id');
    const listed = await listCharacters(chars);
    expect(listed.map((c) => [c.character.id, c.versions])).toEqual([['walt', [1, 2]]]);
  });

  it("refuses a file whose name doesn't match what it holds", async () => {
    const chars = path.join(dir, 'mismatch');
    fs.mkdirSync(chars);
    fs.writeFileSync(path.join(chars, 'eddie.character.json'), serializeCharacter(walt()));
    await expect(readCharacterFile(path.join(chars, 'eddie.character.json'))).rejects.toThrow('its name says "eddie" but it holds walt@1');
  });

  it('resolves stills under the media root, with ~ as home', () => {
    expect(stillPath({ ...walt(), media: { root: '~/m' } }, 'characters/walt/front.png', '/home/x')).toBe('/home/x/m/characters/walt/front.png');
  });

  it('reads approved lines as cut#ids', () => {
    expect(parseLineSelection('docs/cuts/big-hal-take6.cut.json#howdy, thisone')).toEqual({ cut: 'docs/cuts/big-hal-take6.cut.json', lines: ['howdy', 'thisone'] });
    expect(() => parseLineSelection('docs/cuts/x.cut.json')).toThrow('its line ids');
    expect(() => parseLineSelection('docs/cuts/x.cut.json#')).toThrow('its line ids');
  });

  it('shows a character in plain words', () => {
    const text = formatCharacter({ ...walt(), stills: [{ id: 'front', file: 'characters/walt/front.png', from: { take: 'reg4-walt-t1', at: 1.2 } }] }, [1, 2]);
    expect(text).toContain('Walt — walt@1 (versions 1, 2)');
    expect(text).toContain("Voice: the video model's own voice (on camera)");
    expect(text).toContain('reference: not measured yet (mdmedia character measure)');
    expect(text).toContain('front: characters/walt/front.png (reg4-walt-t1 at 1.2 s)');
    expect(text).toContain('v1 2026-10-20: First version.');
  });
});

describe('the voice swap, on files', () => {
  it('puts converted speech back under the same picture, writes a report, and never overwrites', async () => {
    const ffmpeg = await findFfmpeg();
    const take = path.join(dir, 'take.mp4');
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=24:d=1', '-f', 'lavfi', '-i', 'sine=f=220:d=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', take], { ffmpeg });
    const out = path.join(dir, 'swapped', 'take-eric.mp4');
    fs.mkdirSync(path.dirname(out));
    let sent = 0;
    const report = await swapVoice({
      video: take, out, apiKey: 'unused', voice: { id: 'v', name: 'Eric' },
      // A stand-in conversion: half a second of 24 kHz silence.
      convert: async (wav) => { sent = wav.length; return new Uint8Array(24_000); },
    });
    expect(sent).toBeGreaterThan(44);
    for (const f of [out, `${swapStem(out)}.before.wav`, `${swapStem(out)}.after.wav`, `${swapStem(out)}.swap.json`]) expect(fs.existsSync(f)).toBe(true);
    expect(report).toMatchObject({ format: 'mdmedia.voice-swap@1', voice: { id: 'v', name: 'Eric' }, removeBackgroundNoise: true, comparison: null });
    expect(formatSwap(report as SwapReport)).toContain('pass --text to align and compare');
    await expect(swapVoice({ video: take, out, apiKey: 'x', voice: { id: 'v', name: 'Eric' }, convert: async () => new Uint8Array(2) })).rejects.toThrow("Won't overwrite");

    // A failed conversion leaves nothing behind, so the same name can run again.
    const failed = path.join(dir, 'swapped', 'fails.mp4');
    await expect(swapVoice({ video: take, out: failed, apiKey: 'x', voice: { id: 'v', name: 'Eric' }, convert: async () => { throw new Error('quota'); } })).rejects.toThrow('quota');
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.startsWith('fails'))).toEqual([]);
  }, 60_000);
});
