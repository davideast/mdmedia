import { describe, expect, test } from 'bun:test';
import {
  isDirectoryTree,
  verbalizeDirectoryTree,
  parseMarkdownToSpeakableParagraphs,
} from '../../src/chunker/markdown-ast-parser.js';

describe('ASCII Directory Tree Detection & Verbalizer', () => {
  const pyricTree = `pyric-insight-proofs/
├── .jules/
│   └── wiki/
│       ├── graph.json        # 18 goals, 822 insights, solutions graph
│       ├── goals/            # Markdown representations of the 18 goals
│       └── insights/         # Markdown representation of each insight
├── .claude/skills/
│   └── prove-insights/       # Proving protocol, contracts, and lifecycle conventions
│       ├── SKILL.md          # 6-step loop: Locate -> Bootstrap -> Calibrate -> Prove -> Resync -> Finish
│       ├── CONVENTION.md     # Proving folder structure and probe contract
│       └── RUNNER.md         # Runner CLI documentation
├── proofs/
│   ├── proofs.config.json    # sourceRoot, graphPath, sourceSha, claimTimeout
│   ├── runner/               # Execution harness (cli.ts, harness.ts, graph.ts, types.ts)
│   ├── findings/<goal>/      # 822 individual proving directories (finding.json, probe.ts, evidence.md, result.json)
│   └── reports/              # Aggregated audit reports (latest.json, latest.md)
`;

  const simpleTree = `my-app/
├── src/
│   └── index.ts
└── package.json`;

  const asciiPipeTree = `project/
|-- lib/
|   \\-- engine.py
\`-- README.md`;

  const typescriptCode = `import { useState } from 'react';
export function App() {
  const [count, setCount] = useState(0);
  return count;
}`;

  describe('isDirectoryTree', () => {
    test('detects unicode box-drawing trees', () => {
      expect(isDirectoryTree(pyricTree)).toBe(true);
      expect(isDirectoryTree(simpleTree)).toBe(true);
    });

    test('detects ascii pipe and dash trees', () => {
      expect(isDirectoryTree(asciiPipeTree)).toBe(true);
    });

    test('rejects standard programming code snippets', () => {
      expect(isDirectoryTree(typescriptCode)).toBe(false);
      expect(isDirectoryTree('const x = 1;\nconsole.log(x);')).toBe(false);
      expect(isDirectoryTree('{\n  "name": "pkg",\n  "version": "1.0.0"\n}')).toBe(false);
    });
  });

  describe('verbalizeDirectoryTree', () => {
    test('verbalizes hierarchy levels, root directory, and subdirectories for pyricTree', () => {
      const paragraphs = verbalizeDirectoryTree(pyricTree);
      expect(paragraphs.length).toBeGreaterThan(1);

      // First paragraph contains overview with level count, root name, and top subdirs
      const overview = paragraphs[0];
      expect(overview).toContain('The directory structure has 4 levels');
      expect(overview).toContain('pyric-insight-proofs');
      expect(overview).toContain('dot-jules');
      expect(overview).toContain('dot-claude slash skills');
      expect(overview).toContain('proofs');

      // Subsections verbalize details and comments
      const fullText = paragraphs.join(' ');
      expect(fullText).toContain('graph dot json');
      expect(fullText).toContain('18 goals, 822 insights');
      expect(fullText).toContain('SKILL dot md');
      expect(fullText).toContain('proofs.config dot json');

      // No raw box-drawing characters in spoken paragraphs
      expect(fullText).not.toContain('├──');
      expect(fullText).not.toContain('└──');
      expect(fullText).not.toContain('│');
    });

    test('verbalizes simple 2-3 level tree with subdirectories and files', () => {
      const paragraphs = verbalizeDirectoryTree(simpleTree);
      expect(paragraphs.length).toBeGreaterThanOrEqual(1);

      const overview = paragraphs[0];
      expect(overview).toContain('The directory structure has 3 levels');
      expect(overview).toContain('my-app');
      expect(overview).toContain('src');
      expect(overview).toContain('package dot json');
    });
  });

  describe('parseMarkdownToSpeakableParagraphs with directory trees', () => {
    test('translates fenced code block directory tree into speakable paragraphs', () => {
      const markdown = `### 1. Repository Architecture & Ledger Analysis

\`\`\`
${pyricTree}
\`\`\`

#### Overall Verdict Distribution
`;
      const paragraphs = parseMarkdownToSpeakableParagraphs(markdown);

      // Verify heading is present
      expect(paragraphs[0]).toBe('1. Repository Architecture & Ledger Analysis.');

      // Verify tree is verbalized rather than emitted as "Code snippet: pyric-insight-proofs/ ├──..."
      expect(paragraphs[1]).toContain('The directory structure has 4 levels');
      expect(paragraphs[1]).toContain('pyric-insight-proofs');

      // Ensure no raw tree tokens appear anywhere in speakable paragraphs
      for (const p of paragraphs) {
        expect(p).not.toContain('├──');
        expect(p).not.toContain('└──');
        expect(p).not.toContain('│');
        expect(p).not.toContain('Code snippet: pyric-insight-proofs');
      }
    });
  });
});
