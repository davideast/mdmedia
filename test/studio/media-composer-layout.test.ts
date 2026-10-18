import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const composer = readFileSync(resolve(import.meta.dir, '../../studio/src/components/media/media-composer.tsx'), 'utf8');

test('the composer keeps its heading, a 14rem text box and its footer when content below takes the height', () => {
  // A min-h-0 on these grids let the composer shrink below the box's minimum, so
  // the box drew over the footer once the saved drafts list grew.
  expect(composer).not.toMatch(/<div className=\{?[`"]grid min-h-0/);
  expect(composer).toContain('grid-rows-[auto_minmax(14rem,1fr)]');
});

test('the text box keeps a fixed size and scrolls its text instead of growing with it', () => {
  expect(composer).toContain('field-sizing-fixed');
});
