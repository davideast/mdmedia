import { describe, expect, it } from 'bun:test';
import { copyToSystemClipboard } from '../../src/studio/clipboard.js';

describe('copyToSystemClipboard', () => {
  it('returns false when text is empty', async () => {
    const success = await copyToSystemClipboard('');
    expect(success).toBe(false);
  });

  it('copies text to system clipboard on supported platform', async () => {
    const testText = `test-copy-${Date.now()}`;
    const success = await copyToSystemClipboard(testText);
    if (process.platform === 'darwin') {
      expect(success).toBe(true);
    }
  });
});
