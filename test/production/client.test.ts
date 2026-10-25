import { describe, expect, it } from 'bun:test';
import { StudioClient } from '../../src/remote/client';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function recording(answer: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchStub = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { calls, client: new StudioClient('http://localhost:3070', KEY, fetchStub) };
}

describe('studio client: productions', () => {
  it('looks media up by hash, 100 at a time', async () => {
    const hashes = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, '0'));
    const { calls, client } = recording((url) => {
      const asked = url.searchParams.get('sha256')!.split(',');
      return Response.json({ found: Object.fromEntries(asked.slice(0, 1).map((sha) => [sha, { id: `pm${sha.slice(-4)}`, sha256: sha }])) });
    });
    const found = await client.findProductionMedia([...hashes, hashes[0]!]);
    expect(calls.map((c) => c.url.searchParams.get('sha256')!.split(',').length)).toEqual([100, 50]);
    expect(calls.every((c) => c.url.pathname === '/api/v1/productions/media')).toBe(true);
    expect([...found.keys()]).toEqual([hashes[0], hashes[100]]);
  });

  it('uploads raw bytes to the hash, with the type and probed length, and the key', async () => {
    const sha = 'a'.repeat(64);
    const { calls, client } = recording(() => Response.json({ id: 'pm1' }, { status: 201 }));
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    const asset = await client.uploadProductionMedia({ sha256: sha, mediaType: 'video', mimeType: 'video/mp4', byteLength: 3, body, durationMs: 1234.4 });
    expect(asset.id).toBe('pm1');
    const { url, init } = calls[0]!;
    expect(init.method).toBe('PUT');
    expect(url.pathname).toBe(`/api/v1/productions/media/${sha}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ mediaType: 'video', durationMs: '1234' });
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('video/mp4');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init.body).toBe(body);
  });

  it('upserts by slug and replaces cuts by id', async () => {
    const { calls, client } = recording(() => Response.json({ id: 'pr1', cuts: [] }));
    await client.upsertProduction({ slug: 'rigg', title: 'RIGG' });
    await client.putProductionCut('pr1', 'take5', { label: 'Take 5', status: 'review', kind: 'rendered', order: 0, renderedAssetId: 'pm1' });
    await client.updateProduction('pr1', { approvedCutId: null });
    expect(calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      'POST /api/v1/productions',
      'PUT /api/v1/productions/pr1/cuts/take5',
      'PATCH /api/v1/productions/pr1',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ kind: 'rendered', renderedAssetId: 'pm1' });
  });
});
