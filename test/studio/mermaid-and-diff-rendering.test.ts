import { describe, expect, it } from 'bun:test';
import { marked } from 'marked';
import { highlightCode } from '../../studio/src/lib/highlight';
import { parseNarrationRequest } from '../../studio/src/lib/narration-request';

describe('Mermaid and Diff Syntax Highlighting', () => {
  it('highlights diff blocks with inserted and deleted token classes', () => {
    const diffCode = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      '-const version = "1.0.0";',
      '+const version = "1.1.0";',
      ' console.log(version);',
    ].join('\n');

    const html = highlightCode(diffCode, 'diff');

    expect(html).toContain('token deleted');
    expect(html).toContain('token inserted');
    expect(html).toContain('token coord');
    expect(html).toContain('const version = "1.0.0";');
    expect(html).toContain('const version = "1.1.0";');
  });

  it('recognizes patch alias for diff language', () => {
    const patchCode = '+added line\n-removed line';
    const html = highlightCode(patchCode, 'patch');

    expect(html).toContain('token inserted');
    expect(html).toContain('token deleted');
  });

  it('partitions markdown containing mermaid flowchart and diff into distinct typed segments', () => {
    const rawMarkdown = [
      '# Implementation Review',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Input] --> B[Processing]',
      '  B --> C[Output]',
      '```',
      '',
      'Here are the changes applied:',
      '',
      '```diff',
      '@@ -10,3 +10,4 @@',
      '-export function oldMethod() {}',
      '+export function newMethod() {}',
      '+export function helperMethod() {}',
      '```',
    ].join('\n');

    const tokens = marked.lexer(rawMarkdown);
    type Segment =
      | { type: 'html'; html: string }
      | { type: 'code'; text: string; lang?: string };

    const result: Segment[] = [];
    let pendingTokens: Parameters<typeof marked.parser>[0] = [];

    for (const token of tokens) {
      if (token.type === 'code') {
        if (pendingTokens.length > 0) {
          result.push({
            type: 'html',
            html: marked.parser(pendingTokens),
          });
          pendingTokens = [];
        }
        result.push({
          type: 'code',
          text: token.text,
          lang: token.lang,
        });
      } else {
        pendingTokens.push(token);
      }
    }

    if (pendingTokens.length > 0) {
      result.push({
        type: 'html',
        html: marked.parser(pendingTokens),
      });
    }

    expect(result).toHaveLength(4);
    expect(result[0].type).toBe('html');

    // Mermaid segment
    expect(result[1].type).toBe('code');
    if (result[1].type === 'code') {
      expect(result[1].lang?.toLowerCase().trim()).toBe('mermaid');
      expect(result[1].text).toContain('flowchart LR');
    }

    expect(result[2].type).toBe('html');

    // Diff segment
    expect(result[3].type).toBe('code');
    if (result[3].type === 'code') {
      expect(result[3].lang?.toLowerCase().trim()).toBe('diff');
      expect(result[3].text).toContain('+export function newMethod() {}');
    }
  });

  it('correctly parses structureMarkdown in parseNarrationRequest', () => {
    const validWithStructure = parseNarrationRequest({
      markdown: '# Test doc',
      voice: 'Puck',
      promptStyle: 'Direct',
      rewriteForNarration: false,
      structureMarkdown: true,
      visibility: 'private',
    });

    expect(validWithStructure).not.toBeNull();
    expect(validWithStructure?.structureMarkdown).toBe(true);

    const validWithoutStructure = parseNarrationRequest({
      markdown: '# Test doc',
      voice: 'Puck',
      promptStyle: 'Direct',
      rewriteForNarration: false,
      visibility: 'private',
    });

    expect(validWithoutStructure).not.toBeNull();
    expect(validWithoutStructure?.structureMarkdown).toBe(false);
  });

  it('renders GFM alerts into markdown-alert AST containers using markedAlert', async () => {
    const { Marked } = await import('marked');
    const markedAlert = (await import('marked-alert')).default;

    const m = new Marked().use(markedAlert());
    const rendered = m.parse([
      '> [!IMPORTANT]',
      '> Critical Harness Trap in `bin/start-session` (Lines 77–80)',
    ].join('\n')) as string;

    expect(rendered).toContain('markdown-alert markdown-alert-important');
    expect(rendered).toContain('markdown-alert-title');
    expect(rendered).toContain('Important');
    expect(rendered).toContain('Critical Harness Trap');
  });
});
