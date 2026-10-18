// Executed in an isolated process so SDK mocks cannot affect other tests.
import assert from 'node:assert/strict';
import { DAY, HOUR, call, deletedObjects, documents, json, queryReads } from './retention-server-fixture';

const now = Date.now();
const narration = (ownerUid: string, patch: Record<string, unknown> = {}) =>
  ({ ownerUid, title: 'N', status: 'ready', createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, ...patch });
const mediaItem = (id: string, type: string, ownerUid: string, patch: Record<string, unknown> = {}) =>
  ({ id, type, ownerUid, title: id, status: 'ready', createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY, ...patch });

// Owner keeps narrations one day and videos forever. Other has no defaults at all.
documents.set('users/owner', { settings: { retention: { global: null, byType: { narration: { ttl: '1d', since: 0 }, video: null } } } });
documents.set('users/other', { settings: {} });

documents.set('narrations/n-old', narration('owner'));
documents.set('narrations/n-new', narration('owner', { createdAt: now - HOUR }));
documents.set('narrations/n-locked', narration('owner', { locked: true }));
documents.set('narrations/n-streaming', narration('owner', { status: 'streaming', createdAt: now - 3 * DAY, updatedAt: now - 1000, expiresAt: now - HOUR }));
documents.set('narrations/n-stuck', narration('owner', { status: 'streaming', updatedAt: now - DAY }));
documents.set('narrations/o-keep', narration('other'));
documents.set('narrations/o-short', narration('other', { expiresAt: now - 1000 }));

documents.set('mediaItems/image_i-old', mediaItem('i-old', 'image', 'owner', { expiresAt: now - 1000 }));
documents.set('mediaItems/image_i-future', mediaItem('i-future', 'image', 'owner', { expiresAt: now + HOUR }));
documents.set('mediaItems/image_i-locked', mediaItem('i-locked', 'image', 'owner', { expiresAt: now - 1000, locked: true }));
documents.set('mediaItems/image_i-queued', mediaItem('i-queued', 'image', 'owner', { status: 'queued', expiresAt: now - 1000 }));
documents.set('mediaItems/video_v-old', mediaItem('v-old', 'video', 'owner'));
documents.set('mediaItems/narration_n-old', { id: 'narration_n-old', type: 'narration', ownerUid: 'owner' });

// Everything belonging to the expiring image.
documents.set('mediaAssets/a1', { ownerUid: 'owner', itemId: 'i-old', path: 'media/owner/a1/original', thumbnailPath: 'media/owner/a1/thumbnail.webp' });
documents.set('mediaAssets/a-keep', { ownerUid: 'owner', itemId: 'i-future', path: 'media/owner/a-keep/original', thumbnailPath: 'media/owner/a-keep/thumbnail.webp' });
documents.set('mediaGenerations/g1', { ownerUid: 'owner', itemId: 'i-old', type: 'image' });
documents.set('mediaGenerations/g-keep', { ownerUid: 'owner', itemId: 'i-future', type: 'image' });
documents.set('mediaActivity/g1', { ownerUid: 'owner', itemId: 'i-old' });
documents.set('mediaRequests/r1', { ownerUid: 'owner', itemId: 'i-old' });

const { sweepExpired, purgeMediaItem, MediaLockedError } = await import('../../../studio/src/lib/retention-sweep');
const sweepRoutes = {
  preview: await import('../../../studio/src/app/api/v1/retention/preview/route'),
  now: await import('../../../studio/src/app/api/v1/retention/sweep/route'),
};
const ids = (report: { expired: Array<{ type: string; id: string }> }) => report.expired.map((item) => `${item.type}:${item.id}`).sort();

// A sweep reads only items that could be due, never the whole library: not
// recent items, not ones with a future expiry, not kept types, and nothing of
// someone with no defaults beyond what has its own expiry.
queryReads.clear();
const dry = await sweepExpired({ now, dryRun: true });
for (const unread of ['narrations/n-new', 'narrations/o-keep', 'mediaItems/image_i-future', 'mediaItems/video_v-old', 'mediaItems/narration_n-old']) {
  assert.ok(!queryReads.has(unread), `${unread} should not be read by a sweep`);
}
// A dry run reports the right items and deletes nothing.
assert.deepEqual(ids(dry), ['image:i-old', 'narration:n-old', 'narration:n-stuck', 'narration:o-short']);
assert.equal(dry.purged, 0);
assert.ok(documents.has('narrations/n-old') && documents.has('mediaItems/image_i-old'));

// A locked item, a live generation, an unexpired item and a kept type never expire.
for (const kept of ['narration:n-locked', 'narration:n-streaming', 'narration:n-new', 'narration:o-keep', 'image:i-locked', 'image:i-future', 'image:i-queued', 'video:v-old']) {
  assert.ok(!ids(dry).includes(kept), `${kept} must not expire`);
}

// The preview route shows only the caller's items and can try a default first.
let response = await call(sweepRoutes.preview.GET as never, '/x');
let preview = await response.json();
assert.deepEqual(preview.items.map((item: { id: string }) => item.id).sort(), ['i-old', 'n-old', 'n-stuck']);
response = await call(sweepRoutes.preview.GET as never, '/x?target=video&ttl=1d');
assert.ok(!(await response.json()).items.some((item: { id: string }) => item.id === 'v-old'), 'a new default spares items that already exist');
response = await call(sweepRoutes.preview.GET as never, '/x?target=video&ttl=1d&retroactive=1');
assert.ok((await response.json()).items.some((item: { id: string }) => item.id === 'v-old'), 'a retroactive default shows what it would delete');
assert.ok(!(documents.get('users/owner')!.settings.retention.byType.video === undefined), 'previewing must not save anything');
assert.equal(documents.get('users/owner')!.settings.retention.byType.video, null);
assert.equal((await call(sweepRoutes.preview.GET as never, '/x?target=video')).status, 400);
assert.equal((await call(sweepRoutes.preview.GET as never, '/x?target=video&ttl=soon')).status, 400);

// A run deletes at most its limit, oldest expiry first, and says it stopped early.
const limited = await sweepExpired({ now, limit: 1 });
assert.deepEqual([limited.purged, limited.truncated], [1, true]);
assert.equal(limited.expired.length, 4);

// A full run removes the rest, including everything the expired image owned.
const full = await sweepExpired({ now });
assert.equal(full.failed, 0);
for (const gone of ['narrations/n-old', 'narrations/n-stuck', 'narrations/o-short', 'mediaItems/image_i-old', 'mediaAssets/a1', 'mediaGenerations/g1', 'mediaActivity/g1', 'mediaRequests/r1']) {
  assert.equal(documents.has(gone), false, `${gone} should be gone`);
}
for (const kept of ['narrations/n-new', 'narrations/n-locked', 'narrations/n-streaming', 'narrations/o-keep', 'mediaItems/image_i-future', 'mediaItems/image_i-locked', 'mediaItems/image_i-queued', 'mediaItems/video_v-old', 'mediaAssets/a-keep', 'mediaGenerations/g-keep']) {
  assert.ok(documents.has(kept), `${kept} should be kept`);
}
assert.ok(deletedObjects.includes('media/owner/a1/original') && deletedObjects.includes('media/owner/a1/thumbnail.webp'), 'stored files are deleted');
assert.ok(!deletedObjects.some((path) => path.includes('a-keep')), 'other items keep their files');

// Running again finds nothing, and a locked item refuses a direct purge.
assert.deepEqual([(await sweepExpired({ now })).purged, (await sweepExpired({ now })).expired.length], [0, 0]);
await assert.rejects(() => purgeMediaItem('owner', 'image', 'i-locked'), MediaLockedError);
assert.ok(documents.has('mediaItems/image_i-locked'));

// Run-now deletes the caller's expired items; an API key cannot trigger it.
documents.set('mediaItems/image_i-late', mediaItem('i-late', 'image', 'owner', { expiresAt: now - 1 }));
assert.equal((await call(sweepRoutes.now.POST as never, '/x', { method: 'POST', token: '' })).status, 401);
response = await call(sweepRoutes.now.POST as never, '/x', { method: 'POST' });
assert.deepEqual(await response.json(), { purged: 1, failed: 0, truncated: false });
assert.equal(documents.has('mediaItems/image_i-late'), false);

console.log(JSON.stringify({ passed: true }));
