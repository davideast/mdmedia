import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Studio once refused starts after 30 per API key per hour, or with three
 * already in progress, for every media type. The owner never asked for those
 * caps and they stopped real work, so starting media has no cap of its own.
 */
const source = (path: string) => readFileSync(resolve(import.meta.dir, '../../studio/src', path), 'utf8');

describe('starting media', () => {
  for (const path of ['lib/image-server.ts', 'lib/video-server.ts', 'lib/music-server.ts', 'lib/sfx-server.ts', 'app/api/v1/narrations/route.ts']) {
    it(`has no hourly or in-progress cap in ${path}`, () => {
      const code = source(path);
      expect(code).not.toContain('rate_limited');
      expect(code).not.toContain('too_many_in_progress');
      expect(code).not.toMatch(/hourly|createRateLimiter|3_600_000/);
    });
  }
});
