import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'bun:test';

const REPO_ROOT = join(import.meta.dir, '..', '..');

const TARGET_PATHS = [
  'studio/src/components/tree',
  'studio/src/app/(app)/trees',
  'studio/src/components/reader/tree-document-reader.tsx',
  'studio/src/components/reader/document-media-card.tsx',
];

function collectTsFiles(entryPath: string): string[] {
  const abs = join(REPO_ROOT, entryPath);
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) return [abs];
  const results: string[] = [];
  for (const child of readdirSync(abs)) {
    const childRel = join(entryPath, child);
    const childAbs = join(REPO_ROOT, childRel);
    const childStat = statSync(childAbs);
    if (childStat.isDirectory()) {
      results.push(...collectTsFiles(childRel));
    } else if (child.endsWith('.ts') || child.endsWith('.tsx')) {
      results.push(childAbs);
    }
  }
  return results;
}

describe('Markdown Tree Viewer UI Design Standards (Rules 0–9)', () => {
  it('enforces zero margins, zero one-sided padding nudges, zero status dots, and zero dangerouslySetInnerHTML', () => {
    const files = TARGET_PATHS.flatMap(collectTsFiles);
    const violations: string[] = [];

    // Rule 3: No margins (m-*, mx-*, my-*, mt-*, mb-*, ml-*, mr-*, ms-*, me-*, space-x-*, space-y-*)
    const marginTokenRegex = /\b(?:-?m[xytrblse]?-(?:\d+|px|auto|\[[^\]]+\])|space-[xy]-(?:\d+|px|reverse|\[[^\]]+\]))\b/;

    // Rule 4: No one-sided padding nudges (pl-*, pr-*, pt-*, pb-*, ps-*, pe-*)
    const oneSidedPaddingRegex = /\bp[trblse]-(?:\d+|px|\[[^\]]+\])\b/;
    const inlineNudgeStyleRegex = /\b(?:paddingLeft|paddingRight|paddingTop|paddingBottom|margin|marginLeft|marginRight|marginTop|marginBottom)\s*:/;

    // Rule 0: No pulsing or status dots
    const dotNoiseRegex = /\b(?:animate-ping|animate-pulse)\b/;

    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const lineNo = index + 1;
        if (marginTokenRegex.test(line)) {
          violations.push(`${rel}:${lineNo} uses forbidden margin/space utility (Rule 3): ${line.trim()}`);
        }
        if (oneSidedPaddingRegex.test(line) || inlineNudgeStyleRegex.test(line)) {
          violations.push(`${rel}:${lineNo} uses forbidden one-sided padding or inline margin/padding nudge (Rule 4): ${line.trim()}`);
        }
        if (dotNoiseRegex.test(line)) {
          violations.push(`${rel}:${lineNo} uses forbidden pulsing status indicator (Rule 0): ${line.trim()}`);
        }
        if (line.includes('dangerouslySetInnerHTML')) {
          violations.push(`${rel}:${lineNo} uses forbidden dangerouslySetInnerHTML: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
