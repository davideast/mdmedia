import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const studioSrc = resolve(import.meta.dir, '../../studio/src');
const read = (file: string) => readFileSync(join(studioSrc, file), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

describe('page top bars hold only the title and critical actions', () => {
  test('no component passes JSX to a top bar, so every action goes through HeaderAction', () => {
    const offenders = sources(studioSrc).filter((path) => /\bactions=\{\s*</.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(studioSrc, path))).toEqual([]);
  });

  test('the top bar takes at most two typed actions and draws nothing else of its own', () => {
    const panel = read('components/shell/workbench-panel.tsx');
    expect(panel).toContain('actions?: HeaderActions;');
    expect(panel).not.toContain('PinWorkButton');
    expect(read('components/shell/header-action.tsx')).toContain('export type HeaderActions = readonly [HeaderAction] | readonly [HeaderAction, HeaderAction];');
  });

  test('the top bar shows no loading or status state', () => {
    for (const file of ['components/shell/workbench-panel.tsx', 'components/shell/header-action.tsx']) {
      const source = read(file);
      expect(source).not.toContain('Loader2');
      expect(source).not.toMatch(/\bbusy\b/);
      expect(source).not.toContain('animate-spin');
    }
  });

  test('every action is a filled circle of the same size, so Copy and Play read at one scale', () => {
    const actions = read('components/shell/header-action.tsx');
    expect(actions).toContain('size-8');
    expect(actions).toContain('rounded-full');
    expect(actions).toContain('bg-foreground text-background');
    expect(actions).toMatch(/: "bg-foreground\/\d+ text-foreground/);
  });

  test('pinning and retention live in the right panel', () => {
    for (const file of ['components/narration/narration-settings.tsx', 'components/studio/composer-settings.tsx', 'components/shell/context-panel.tsx']) {
      expect(read(file)).toContain('<KeepSection');
    }
    expect(read('app/(app)/narration/[id]/page.tsx')).not.toContain('RetentionControl');
  });
});
