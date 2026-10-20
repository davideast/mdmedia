import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newCharacter, serializeCharacter } from '../../src/character/character.js';
import { ManifestError, parseProductionManifest, PRODUCTION_FORMAT } from '../../src/production/manifest.js';
import { describePush, pushProduction, type ProductionPushClient } from '../../src/production/push.js';
import type { CharacterVersionBody, ProductionAsset, ProductionMediaUpload, ProductionUpsert } from '../../src/remote/client.js';

let dir: string;
let repo: string;
let root: string;
const write = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-cast-'));
  repo = path.join(dir, 'repo');
  root = path.join(dir, 'media');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  write(path.join(root, 'review/clips/ep.mp4'), 'rendered');
  write(path.join(root, 'characters/rick/driving.png'), 'rick still');
  const rick = { ...newCharacter({ id: 'rick', name: 'Rick', root, date: '2026-10-20' }), stills: [{ id: 'driving', file: 'characters/rick/driving.png', from: { take: 'nw7-rick-lines-t1', at: 1 } }] };
  write(path.join(repo, 'docs/characters/rick.character.json'), serializeCharacter(rick));
  write(path.join(repo, 'docs/characters/buddy.character.json'), serializeCharacter(newCharacter({ id: 'buddy', name: 'Buddy', kind: 'thing', root, date: '2026-10-20' })));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const manifestJson = (cast: unknown) => ({
  format: PRODUCTION_FORMAT, slug: 'ep', title: 'Episode', media: { root },
  cast,
  cuts: [{ id: 'take1', rendered: 'review/clips/ep.mp4', label: 'Take 1' }],
});
const file = () => path.join(repo, 'docs/productions/ep.production.json');

describe('a production manifest cast', () => {
  it('names each role and the character version that plays it', () => {
    const m = parseProductionManifest(manifestJson([{ role: 'Rick', character: 'rick@1' }, { role: 'Buddy', character: 'buddy@1' }]), file());
    expect(m.cast).toEqual([{ role: 'Rick', character: { id: 'rick', version: 1 } }, { role: 'Buddy', character: { id: 'buddy', version: 1 } }]);
    expect(parseProductionManifest(manifestJson(undefined), file()).cast).toEqual([]);
  });

  it('needs a version, and casts each role once', () => {
    let error: unknown;
    try {
      parseProductionManifest(manifestJson([{ role: 'Rick', character: 'rick' }, { role: 'Buddy', character: 'buddy@1' }, { role: 'Buddy', character: 'buddy@1' }, { character: 'x@1' }]), file());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ManifestError);
    const message = (error as Error).message;
    expect(message).toContain('cast[0].character: expected a character and its version, like "big-hal@1"');
    expect(message).toContain('cast: the role "Buddy" is cast twice');
    expect(message).toContain('cast[3].role: expected the speaker name the cuts use');
  });
});

describe('pushing a production with a cast', () => {
  it('uploads the stills, stores each character version, then links the production to them', async () => {
    const calls: string[] = [];
    const media = new Map<string, ProductionAsset>();
    const versions: Array<{ slug: string; version: number; body: CharacterVersionBody }> = [];
    let upsert: ProductionUpsert | null = null;
    const client: ProductionPushClient = {
      async findProductionMedia(hashes) { return new Map(hashes.filter((h) => media.has(h)).map((h) => [h, media.get(h)!])); },
      async uploadProductionMedia(upload: ProductionMediaUpload) {
        const asset = { id: `pm${upload.sha256.slice(0, 8)}`, mediaType: upload.mediaType, mimeType: upload.mimeType, byteLength: upload.byteLength, sha256: upload.sha256, width: 0, height: 0, links: { content: '', thumbnail: null } };
        media.set(upload.sha256, asset);
        calls.push(`upload ${upload.mediaType}`);
        return asset;
      },
      async putCharacterVersion(slug, version, body) {
        calls.push(`character ${slug}@${version}`);
        versions.push({ slug, version, body });
        return {} as never;
      },
      async upsertProduction(body) {
        calls.push('production');
        upsert = body;
        return { id: 'pr1', slug: 'ep', title: 'Episode', series: null, coverAssetId: null, currentCutId: null, approvedCutId: null, cutCount: 0, cuts: [], createdAt: 0, updatedAt: 0, links: { self: '', cover: null, coverThumbnail: null } };
      },
      async updateProduction() { return {} as never; },
      async putProductionCut() { calls.push('cut'); return {}; },
      async deleteProductionCut() {},
    };
    const m = parseProductionManifest(manifestJson([{ role: 'Rick', character: 'rick@1' }, { role: 'Buddy', character: 'buddy@1' }]), file());
    const report = await pushProduction(client, m, { thumbs: null, duration: async () => undefined });

    expect(calls).toEqual(['upload image', 'upload video', 'character rick@1', 'character buddy@1', 'production', 'cut']);
    const stillHash = createHash('sha256').update('rick still').digest('hex');
    expect(versions[0].body.stills).toEqual({ driving: media.get(stillHash)!.id });
    expect((versions[0].body.character as { id: string }).id).toBe('rick');
    expect(versions[1].body.stills).toEqual({});
    expect(upsert!.cast).toEqual([{ role: 'Rick', character: 'rick@1' }, { role: 'Buddy', character: 'buddy@1' }]);
    expect(report.characters).toEqual(['rick@1', 'buddy@1']);
    expect(describePush(report)).toContain('; cast rick@1, buddy@1;');
  });

  it("refuses a cast whose character version isn't there", async () => {
    const m = parseProductionManifest(manifestJson([{ role: 'Rick', character: 'rick@2' }]), file());
    const client = { putCharacterVersion: async () => ({}) } as unknown as ProductionPushClient;
    await expect(pushProduction(client, m, { thumbs: null })).rejects.toThrow('No rick@2');
  });

  it('sends no cast for a manifest without one, so the studio keeps its own', async () => {
    let upsert: ProductionUpsert | null = null;
    const client = {
      findProductionMedia: async () => new Map(),
      uploadProductionMedia: async (u: ProductionMediaUpload) => ({ id: 'pm1', mediaType: u.mediaType, mimeType: u.mimeType, byteLength: 1, sha256: u.sha256, width: 0, height: 0, links: { content: '', thumbnail: null } }),
      upsertProduction: async (body: ProductionUpsert) => { upsert = body; return { id: 'pr1', cuts: [], approvedCutId: null, currentCutId: null }; },
      updateProduction: async () => ({}),
      putProductionCut: async () => ({}),
      deleteProductionCut: async () => {},
    } as unknown as ProductionPushClient;
    await pushProduction(client, parseProductionManifest(manifestJson(undefined), file()), { thumbs: null, duration: async () => undefined });
    expect(upsert!).not.toHaveProperty('cast');
  });
});
