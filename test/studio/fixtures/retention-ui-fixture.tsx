// Executed in an isolated process so module mocks cannot affect other tests.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
// Studio's own React pair: the workspace root hoists a mismatched react-dom.
import { createElement } from '../../../studio/node_modules/react';
import { renderToStaticMarkup } from '../../../studio/node_modules/react-dom/server';

const NOW = Date.now();
const retention = { global: { ttl: '30d', since: 0 }, byType: { narration: { ttl: '7d', since: 0 }, video: null } };
mock.module('../../../studio/src/lib/auth-context', () => ({ useAuth: () => ({ profile: { settings: { retention } } }) }));
mock.module('../../../studio/src/lib/media-client', () => ({
  MediaClientError: class extends Error {},
  studioJson: async () => ({ retention: { locked: false, expiresAt: null, effectiveExpiresAt: NOW + 3 * 86_400_000, source: 'type-default' }, items: [], count: 0 }),
}));

const { RetentionSettings } = await import('../../../studio/src/components/studio/retention-settings');
const { RetentionControl } = await import('../../../studio/src/components/studio/retention-control');

const html = renderToStaticMarkup(createElement(RetentionSettings));
// One labelled row per media type plus the global one, showing the saved values.
for (const label of ['Everything else', 'Narration', 'Image', 'Video', 'Music', 'Sound effect', 'Delete expired items now']) {
  assert.ok(html.includes(label), `settings should show "${label}"`);
}
assert.ok(html.includes('Deleted 7 days after they are made'), 'the narration row explains its 7 day default');
assert.ok(html.includes('Kept forever, even if everything else expires.'), 'video is explicitly kept');
assert.ok(html.includes('Follows the setting for everything else.'), 'types without a setting inherit');
assert.ok(html.includes('Items without their own setting are kept forever.') === false, 'the global row shows its 30 day default, not keep');

// The control renders nothing until it knows the item is yours, and never throws.
assert.equal(renderToStaticMarkup(createElement(RetentionControl, { type: 'narration', id: 'abc' })), '');
console.log(JSON.stringify({ passed: true }));
