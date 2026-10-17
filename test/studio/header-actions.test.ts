import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const studioSrc = resolve(import.meta.dir, '../../studio/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

describe('page headers hold only the essentials', () => {
  test('no component passes JSX to a header, so every action goes through HeaderAction', () => {
    const offenders = sources(studioSrc).filter((path) => /\bactions=\{\s*</.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(studioSrc, path))).toEqual([]);
  });

  test('the header takes at most two typed actions and draws nothing else of its own', () => {
    const panel = readFileSync(join(studioSrc, 'components/shell/workbench-panel.tsx'), 'utf8');
    expect(panel).toContain('actions?: HeaderActions;');
    expect(panel).not.toContain('PinWorkButton');
    const actions = readFileSync(join(studioSrc, 'components/shell/header-action.tsx'), 'utf8');
    expect(actions).toContain('export type HeaderActions = readonly [HeaderAction] | readonly [HeaderAction, HeaderAction];');
  });

  test('pinning and retention live in the right panel', () => {
    for (const file of ['components/narration/narration-settings.tsx', 'components/studio/composer-settings.tsx', 'components/shell/context-panel.tsx']) {
      expect(readFileSync(join(studioSrc, file), 'utf8')).toContain('<KeepSection');
    }
    expect(readFileSync(join(studioSrc, 'app/(app)/narration/[id]/page.tsx'), 'utf8')).not.toContain('RetentionControl');
  });
});
