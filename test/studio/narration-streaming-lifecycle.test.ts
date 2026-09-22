import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Narration Streaming Lifecycle & Pre-Creation Resilience', () => {
  const narrationServerSource = readFileSync(
    join(process.cwd(), 'studio/src/lib/narration-server.ts'),
    'utf-8'
  );
  const narrationsSource = readFileSync(
    join(process.cwd(), 'studio/src/lib/narrations.ts'),
    'utf-8'
  );
  const readerPageSource = readFileSync(
    join(process.cwd(), 'studio/src/app/(app)/narration/[id]/page.tsx'),
    'utf-8'
  );

  describe('Seam 1: Immediate Document Initialization (narration-server.ts)', () => {
    it('seeds the Firestore document before executing GeminiNarrationAdapter or long-running async steps', () => {
      // Find position of initial docRef.set and position of adaptForNarration
      const initialSetIndex = narrationServerSource.indexOf('await docRef.set(');
      const adaptIndex = narrationServerSource.indexOf('adaptForNarration(');

      expect(initialSetIndex).toBeGreaterThan(-1);
      expect(adaptIndex).toBeGreaterThan(-1);
      // docRef.set MUST occur before adaptForNarration so the document exists in Firestore immediately
      expect(initialSetIndex).toBeLessThan(adaptIndex);
    });

    it('sets docWritten = true immediately upon seeding initial document', () => {
      const setDocPos = narrationServerSource.indexOf('await docRef.set(');
      const docWrittenPos = narrationServerSource.indexOf('docWritten = true;', setDocPos);

      expect(docWrittenPos).toBeGreaterThan(-1);
      expect(docWrittenPos - setDocPos).toBeLessThan(200);
    });
  });

  describe('Seam 2: Subscription Pool & watchNarration Error Propagation (narrations.ts)', () => {
    it('supplies an onError handler to onSnapshot to prevent fatal unhandled listener termination', () => {
      const watchNarrationDef = narrationsSource.slice(
        narrationsSource.indexOf('export function watchNarration('),
        narrationsSource.indexOf('export async function getNarrationOnce(')
      );

      // Must pass onError callback parameter into onSnapshot
      expect(watchNarrationDef).toContain('onSnapshot(');
      expect(watchNarrationDef).toMatch(/onSnapshot\([^,]+,\s*\([^)]*\)\s*=>\s*\{[^}]*\},\s*\([^)]*\)\s*=>/);
    });
  });

  describe('Seam 3: Reader View In-Flight Queue Awareness (page.tsx)', () => {
    it('checks generationQueue for active in-flight jobs matching narrationId', () => {
      expect(readerPageSource).toContain('generationQueue');
      expect(readerPageSource).toMatch(/generationQueue\.jobs\.find/);
    });

    it('renders active progress indicator when an in-flight job is actively synthesizing', () => {
      expect(readerPageSource).toContain('Synthesizing audio');
    });
  });
});
