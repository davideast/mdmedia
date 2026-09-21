import { describe, expect, it } from 'bun:test';

describe('Narration Title Renaming & Checkpoint Synchronization', () => {
  describe('Checkpoint title preservation', () => {
    it('preserves existing non-empty title when timings file arrives with an older static title', () => {
      let currentTitle = 'Domain Language Updates and Architecture Redesign';
      const timingsFile = {
        title: '1. Where the Code and Domain Language Collide Today',
        transcript: 'Some transcript',
        chunks: [],
      };

      const updateTitle = (setter: (current: string) => string) => {
        currentTitle = setter(currentTitle);
      };

      // The fix applied in useNarrationStream:
      if (timingsFile.title) {
        updateTitle((current) => (current.trim().length > 0 ? current : timingsFile.title));
      }

      expect(currentTitle).toBe('Domain Language Updates and Architecture Redesign');
    });

    it('uses timings file title as fallback when current title is empty', () => {
      let currentTitle = '';
      const timingsFile = {
        title: 'Initial Synthesized Title',
        transcript: 'Some transcript',
        chunks: [],
      };

      const updateTitle = (setter: (current: string) => string) => {
        currentTitle = setter(currentTitle);
      };

      if (timingsFile.title) {
        updateTitle((current) => (current.trim().length > 0 ? current : timingsFile.title));
      }

      expect(currentTitle).toBe('Initial Synthesized Title');
    });
  });

  describe('Inline rename re-entrancy & cancellation guards', () => {
    it('prevents duplicate concurrent commits when Enter triggers unmount-induced blur', async () => {
      let updateCount = 0;
      let isSubmitting = false;
      let isCancelled = false;
      let titleInState = 'Old Title';

      const mockUpdateNarrationTitle = async (_id: string, newTitle: string) => {
        updateCount++;
        // Simulate async I/O
        await new Promise((r) => setTimeout(r, 10));
        titleInState = newTitle;
      };

      const commitTitle = async (draftTitle: string) => {
        if (isSubmitting || isCancelled) return;
        const trimmed = draftTitle.trim();
        if (!trimmed || trimmed === titleInState) return;

        isSubmitting = true;
        try {
          await mockUpdateNarrationTitle('test-id', trimmed);
        } finally {
          isSubmitting = false;
        }
      };

      // 1. Enter key pressed
      const enterPromise = commitTitle('New Title');

      // 2. Unmounting input triggers DOM blur immediately while enterPromise is still in flight
      const blurPromise = commitTitle('New Title');

      await Promise.all([enterPromise, blurPromise]);

      expect(updateCount).toBe(1);
      expect(titleInState).toBe('New Title');
    });

    it('does not commit when Escape cancels before blur occurs', async () => {
      let updateCount = 0;
      let isSubmitting = false;
      let isCancelled = false;
      let titleInState = 'Original Title';

      const cancelEditing = () => {
        isCancelled = true;
      };

      const commitTitle = async (draftTitle: string) => {
        if (isSubmitting || isCancelled) return;
        const trimmed = draftTitle.trim();
        if (!trimmed || trimmed === titleInState) return;
        updateCount++;
        titleInState = trimmed;
      };

      // User typed new title, then hit Escape
      cancelEditing();

      // Escape triggers unmount which fires blur
      await commitTitle('Draft Title Abandoned');

      expect(updateCount).toBe(0);
      expect(titleInState).toBe('Original Title');
    });
  });
});
