import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canDelete,
  isExpired,
  parseTtl,
  readRetentionSettings,
  resolveExpiry,
  setDefaultTtl,
  type RetentionSettings,
} from '../../studio/src/lib/retention';
import { readSettings } from '../../studio/src/lib/settings';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const none: RetentionSettings = { global: null, byType: {} };

describe('parseTtl', () => {
  test('reads minutes, hours, days and weeks', () => {
    expect(parseTtl('90m')).toBe(90 * 60_000);
    expect(parseTtl('6h')).toBe(6 * HOUR);
    expect(parseTtl('3d')).toBe(3 * DAY);
    expect(parseTtl('2w')).toBe(14 * DAY);
    expect(parseTtl(' 12H ')).toBe(12 * HOUR);
  });

  test('rejects anything that is not a positive whole duration', () => {
    for (const bad of ['', '0h', '-1d', '1.5h', 'h', '5', '5y', '10 days', 'soon', '99999w']) {
      expect(parseTtl(bad)).toBeUndefined();
    }
  });
});

describe('resolveExpiry', () => {
  const item = { type: 'narration' as const, createdAt: NOW, locked: false, expiresAt: null, status: 'ready' as const };

  test('an item with no TTL and no default never expires', () => {
    expect(resolveExpiry(item, none)).toBeNull();
    expect(isExpired(item, none, NOW + 1000 * DAY)).toBe(false);
  });

  test("an item's own TTL wins over every default", () => {
    const settings: RetentionSettings = { global: { ttl: '30d', since: 0 }, byType: { narration: { ttl: '7d', since: 0 } } };
    expect(resolveExpiry({ ...item, expiresAt: NOW + 2 * HOUR }, settings)).toBe(NOW + 2 * HOUR);
  });

  test('the media type default wins over the global default', () => {
    const settings: RetentionSettings = { global: { ttl: '30d', since: 0 }, byType: { narration: { ttl: '7d', since: 0 } } };
    expect(resolveExpiry(item, settings)).toBe(NOW + 7 * DAY);
    expect(resolveExpiry({ ...item, type: 'image' }, settings)).toBe(NOW + 30 * DAY);
  });

  test('a null type default keeps that type forever even when a global default exists', () => {
    const settings: RetentionSettings = { global: { ttl: '30d', since: 0 }, byType: { video: null } };
    expect(resolveExpiry({ ...item, type: 'video' }, settings)).toBeNull();
    expect(resolveExpiry(item, settings)).toBe(NOW + 30 * DAY);
  });

  test('a default only reaches items created on or after it was set', () => {
    const settings: RetentionSettings = { global: null, byType: { narration: { ttl: '1d', since: NOW } } };
    expect(resolveExpiry({ ...item, createdAt: NOW - 1 }, settings)).toBeNull();
    expect(resolveExpiry({ ...item, createdAt: NOW }, settings)).toBe(NOW + DAY);
  });

  test('a locked item never expires, whatever its TTL or the defaults say', () => {
    const settings: RetentionSettings = { global: { ttl: '1h', since: 0 }, byType: {} };
    const locked = { ...item, locked: true, expiresAt: NOW + HOUR };
    expect(resolveExpiry(locked, settings)).toBeNull();
    expect(isExpired(locked, settings, NOW + 99 * DAY)).toBe(false);
    expect(canDelete(locked)).toBe(false);
    expect(canDelete(item)).toBe(true);
  });

  test('an item still generating is never expired', () => {
    const generating = { ...item, status: 'generating' as const, expiresAt: NOW + 1 };
    expect(isExpired(generating, none, NOW + DAY)).toBe(false);
    expect(isExpired({ ...item, expiresAt: NOW + 1 }, none, NOW + DAY)).toBe(true);
  });

  test('an unreadable default is ignored instead of deleting everything', () => {
    const settings = { global: { ttl: 'garbage', since: 0 }, byType: {} } as RetentionSettings;
    expect(resolveExpiry(item, settings)).toBeNull();
  });
});

describe('setDefaultTtl', () => {
  test('a new default applies from now on unless it is made retroactive', () => {
    expect(setDefaultTtl(none, 'narration', '7d', NOW, false).byType.narration).toEqual({ ttl: '7d', since: NOW });
    expect(setDefaultTtl(none, 'narration', '7d', NOW, true).byType.narration).toEqual({ ttl: '7d', since: 0 });
    expect(setDefaultTtl(none, 'global', '30d', NOW, false).global).toEqual({ ttl: '30d', since: NOW });
  });

  test('keep and inherit are different answers for a type', () => {
    const base = setDefaultTtl(none, 'narration', '7d', NOW, false);
    expect(setDefaultTtl(base, 'narration', 'keep', NOW, false).byType.narration).toBeNull();
    expect('narration' in setDefaultTtl(base, 'narration', 'inherit', NOW, false).byType).toBe(false);
  });

  test('an invalid TTL is refused and leaves the settings untouched', () => {
    expect(() => setDefaultTtl(none, 'narration', 'soon', NOW, false)).toThrow();
  });
});

describe('settings storage', () => {
  test('missing or malformed retention reads as keep everything', () => {
    expect(readRetentionSettings(undefined)).toEqual(none);
    expect(readRetentionSettings({ global: 5, byType: 'x' })).toEqual(none);
  });

  test('drops unknown media types and unreadable entries', () => {
    const read = readRetentionSettings({
      global: { ttl: '30d', since: 12 },
      byType: { narration: { ttl: '7d', since: 3 }, video: null, podcast: { ttl: '1d', since: 0 }, image: { ttl: 'nope', since: 0 } },
    });
    expect(read).toEqual({ global: { ttl: '30d', since: 12 }, byType: { narration: { ttl: '7d', since: 3 }, video: null } });
  });

  test('profile settings carry retention through readSettings', () => {
    expect(readSettings({}).retention).toEqual(none);
    expect(readSettings({ retention: { global: null, byType: { narration: { ttl: '7d', since: 0 } } } }).retention?.byType.narration)
      .toEqual({ ttl: '7d', since: 0 });
  });
});

describe('firestore rules', () => {
  test('an owner cannot delete a locked narration directly', () => {
    for (const file of ['firestore.modules.rules', 'firestore.rules']) {
      const rules = readFileSync(resolve(import.meta.dir, '../../studio', file), 'utf8');
      const block = rules.slice(rules.indexOf('match /narrations/{narrationId}'));
      const del = block.slice(block.indexOf('allow delete'), block.indexOf(';', block.indexOf('allow delete')));
      expect(del).toContain("resource.data.get('locked', false) != true");
    }
  });
});
