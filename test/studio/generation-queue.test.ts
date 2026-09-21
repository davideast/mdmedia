import { describe, expect, it } from 'bun:test';

interface GenerationJob {
  id: string;
  narrationId: string | null;
  title: string;
  status: 'queued' | 'starting' | 'streaming' | 'ready' | 'error';
  totalChunks: number;
  completedChunks: number;
}

function deriveInitialTitle(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'Untitled Narration';
  const first = lines[0].replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  return first.slice(0, 60) || 'Untitled Narration';
}

function getActiveCount(jobs: GenerationJob[]): number {
  return jobs.filter(
    (j) => j.status === 'queued' || j.status === 'starting' || j.status === 'streaming',
  ).length;
}

function clearCompleted(jobs: GenerationJob[]): GenerationJob[] {
  return jobs.filter(
    (j) => j.status === 'queued' || j.status === 'starting' || j.status === 'streaming',
  );
}

describe('Generation Queue - State and Helpers', () => {
  describe('deriveInitialTitle', () => {
    it('extracts title from top h1 heading', () => {
      const md = '# The Future of Audio\n\nSome introductory content.';
      expect(deriveInitialTitle(md)).toBe('The Future of Audio');
    });

    it('strips markdown formatting like bold and backticks', () => {
      const md = '### **Bold Announcement** about `tts-flash`\nDetails.';
      expect(deriveInitialTitle(md)).toBe('Bold Announcement about tts-flash');
    });

    it('falls back to "Untitled Narration" when markdown is empty or pure whitespace', () => {
      expect(deriveInitialTitle('')).toBe('Untitled Narration');
      expect(deriveInitialTitle('   \n\n   ')).toBe('Untitled Narration');
    });

    it('truncates long titles to 60 characters', () => {
      const longTitle = '# ' + 'A'.repeat(100);
      expect(deriveInitialTitle(longTitle).length).toBe(60);
    });
  });

  describe('Queue job filtering', () => {
    const sampleJobs: GenerationJob[] = [
      { id: '1', narrationId: 'n1', title: 'Job 1', status: 'queued', totalChunks: 0, completedChunks: 0 },
      { id: '2', narrationId: 'n2', title: 'Job 2', status: 'starting', totalChunks: 0, completedChunks: 0 },
      { id: '3', narrationId: 'n3', title: 'Job 3', status: 'streaming', totalChunks: 5, completedChunks: 2 },
      { id: '4', narrationId: 'n4', title: 'Job 4', status: 'ready', totalChunks: 4, completedChunks: 4 },
      { id: '5', narrationId: null, title: 'Job 5', status: 'error', totalChunks: 0, completedChunks: 0 },
    ];

    it('correctly counts active jobs (queued, starting, streaming)', () => {
      expect(getActiveCount(sampleJobs)).toBe(3);
    });

    it('clears completed and errored jobs while preserving active jobs', () => {
      const activeOnly = clearCompleted(sampleJobs);
      expect(activeOnly.length).toBe(3);
      expect(activeOnly.map((j) => j.id)).toEqual(['1', '2', '3']);
    });
  });
});
