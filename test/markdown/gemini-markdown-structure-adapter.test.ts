import { describe, expect, it, mock } from 'bun:test';
import { GeminiMarkdownStructureAdapter } from '../../src/markdown/gemini-markdown-structure-adapter.js';
import { buildMarkdownStructureSystemInstruction } from '../../src/markdown/system-instructions.js';
import type { GoogleGenAI } from '@google/genai';

describe('GeminiMarkdownStructureAdapter', () => {
  it('returns empty string when input is blank without calling model', async () => {
    const mockGenerateContent = mock(async () => ({ text: 'Should not be called' }));
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient);
    const result = await adapter.structureMarkdown('   \n  ');

    expect(result).toBe('');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('calls gemini-3.5-flash-lite by default with temperature 0.1 and strips outer markdown fence', async () => {
    let capturedModel = '';
    let capturedPrompt = '';
    let capturedTemp = -1;
    const mockGenerateContent = mock(async ({ model, contents, config }: any) => {
      capturedModel = model;
      capturedPrompt = contents[0].parts[0].text;
      capturedTemp = config.temperature;
      return {
        text: '```markdown\n# Architecture\n\n```mermaid\nflowchart LR\nA --> B\n```\n```',
      };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient);
    const result = await adapter.structureMarkdown('# Architecture\n\nASCII flow A -> B');

    expect(capturedModel).toBe('gemini-3.5-flash-lite');
    expect(capturedTemp).toBe(0.1);
    expect(capturedPrompt).toContain('# Architecture');
    expect(capturedPrompt).toContain('Clean and normalize the structure');
    // Outer fence is stripped, inner mermaid fence is preserved
    expect(result).toBe('# Architecture\n\n```mermaid\nflowchart LR\nA --> B\n```');
  });

  it('strips outer markdown fence with Windows CRLF line endings', async () => {
    const mockGenerateContent = mock(async () => ({
      text: '```markdown\r\n# CRLF Heading\r\n\r\nParagraph text.\r\n```',
    }));
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient);
    const result = await adapter.structureMarkdown('Raw input');

    expect(result).toBe('# CRLF Heading\r\n\r\nParagraph text.');
  });

  it('preserves genuine code blocks when a document starts and ends with code snippets', async () => {
    const inputWithLegitimateFences = [
      '```bash',
      'npm run build',
      '```',
      '',
      'Some middle explanation.',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');

    const mockGenerateContent = mock(async () => ({
      text: inputWithLegitimateFences,
    }));
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient);
    const result = await adapter.structureMarkdown('Raw input');

    expect(result).toBe(inputWithLegitimateFences);
  });

  it('enforces non-rewriting invariant and structural mandates in system instruction', async () => {
    let capturedInstruction = '';
    const mockGenerateContent = mock(async ({ config }: any) => {
      capturedInstruction = config.systemInstruction;
      return { text: 'Structured markdown' };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient);
    await adapter.structureMarkdown('Some sloppy doc');

    expect(capturedInstruction).toContain('CRITICAL NON-REWRITING INVARIANT');
    expect(capturedInstruction).toContain('Do NOT rewrite, summarize, rephrase, condense, or omit any text');
    expect(capturedInstruction).toContain('Heading Hierarchy');
    expect(capturedInstruction).toContain('Code Blocks & Fences');
    expect(capturedInstruction).toContain('diff');
    expect(capturedInstruction).toContain('Mermaid');
    expect(capturedInstruction).toContain('Tables');
    expect(capturedInstruction).toContain('OUTPUT FORMAT');
  });

  it('combines custom prompt extensions from constructor and method call', async () => {
    let capturedInstruction = '';
    const mockGenerateContent = mock(async ({ config }: any) => {
      capturedInstruction = config.systemInstruction;
      return { text: 'Custom output' };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient, {
      customPrompt: 'Constructor rule: preserve citations.',
    });
    await adapter.structureMarkdown('Doc text', {
      customPrompt: 'Call rule: ensure 2 spaces for nested lists.',
    });

    expect(capturedInstruction).toContain('Constructor rule: preserve citations.');
    expect(capturedInstruction).toContain('Call rule: ensure 2 spaces for nested lists.');
  });

  it('supports custom model and temperature configuration', async () => {
    let capturedModel = '';
    let capturedTemp = -1;
    const mockGenerateContent = mock(async ({ model, config }: any) => {
      capturedModel = model;
      capturedTemp = config.temperature;
      return { text: 'Output' };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiMarkdownStructureAdapter(mockClient, {
      model: 'gemini-1.5-pro',
      temperature: 0.3,
    });
    await adapter.structureMarkdown('Sample text');

    expect(capturedModel).toBe('gemini-1.5-pro');
    expect(capturedTemp).toBe(0.3);
  });
});
