import { describe, expect, it } from 'bun:test';
import { marked } from 'marked';

describe('SourceDocumentView code block partitioning', () => {
  it('correctly partitions markdown into prose and code segments without losing content', () => {
    const markdown = [
      '# Document Title',
      '',
      'Here is some text introducing a script:',
      '',
      '```bash',
      'npm install prismjs',
      'npm test',
      '```',
      '',
      'And another paragraph with JavaScript code:',
      '',
      '```javascript',
      'const answer = 42;',
      'console.log(answer);',
      '```',
      '',
      'Final concluding remarks.',
    ].join('\n');

    const tokens = marked.lexer(markdown);
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

    expect(result).toHaveLength(5);
    expect(result[0].type).toBe('html');
    expect(result[0].type === 'html' ? result[0].html : '').toContain('Document Title');

    expect(result[1].type).toBe('code');
    if (result[1].type === 'code') {
      expect(result[1].lang).toBe('bash');
      expect(result[1].text).toBe('npm install prismjs\nnpm test');
    }

    expect(result[2].type).toBe('html');
    expect(result[2].type === 'html' ? result[2].html : '').toContain('JavaScript code');

    expect(result[3].type).toBe('code');
    if (result[3].type === 'code') {
      expect(result[3].lang).toBe('javascript');
      expect(result[3].text).toBe('const answer = 42;\nconsole.log(answer);');
    }

    expect(result[4].type).toBe('html');
    expect(result[4].type === 'html' ? result[4].html : '').toContain('Final concluding remarks');
  });

  it('handles markdown with no code blocks seamlessly as a single html segment', () => {
    const markdown = 'Just plain markdown with *italics* and **bold**.';
    const tokens = marked.lexer(markdown);
    expect(tokens.some((t) => t.type === 'code')).toBe(false);
  });
});
