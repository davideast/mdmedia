import { describe, expect, it, mock } from 'bun:test';
import { GeminiNarrationAdapter } from '../../src/narration/gemini-narration-adapter.js';
import type { GoogleGenAI } from '@google/genai';

describe('GeminiNarrationAdapter', () => {
  it('returns empty string when input is blank without calling model', async () => {
    const mockGenerateContent = mock(async () => ({ text: 'Should not be called' }));
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiNarrationAdapter(mockClient);
    const result = await adapter.adaptForNarration('   \n  ');

    expect(result).toBe('');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('calls gemini-3.5-flash-lite by default and strips markdown code fences from response', async () => {
    let capturedModel = '';
    let capturedPrompt = '';
    const mockGenerateContent = mock(async ({ model, contents }: any) => {
      capturedModel = model;
      capturedPrompt = contents[0].parts[0].text;
      return {
        text: '```markdown\nWelcome to the Audio Studio Architecture guide.\n```',
      };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiNarrationAdapter(mockClient);
    const result = await adapter.adaptForNarration('# Audio Studio\n\n```mermaid\nflow\n```');

    expect(capturedModel).toBe('gemini-3.5-flash-lite');
    expect(capturedPrompt).toContain('# Audio Studio');
    expect(result).toBe('Welcome to the Audio Studio Architecture guide.');
  });

  it('supports custom model and temperature options', async () => {
    let capturedModel = '';
    let capturedTemp = 0;
    const mockGenerateContent = mock(async ({ model, config }: any) => {
      capturedModel = model;
      capturedTemp = config.temperature;
      return {
        text: 'Custom adapted narration text.',
      };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiNarrationAdapter(mockClient, {
      model: 'custom-model-preview',
      temperature: 0.4,
    });
    const result = await adapter.adaptForNarration('Sample text');

    expect(capturedModel).toBe('custom-model-preview');
    expect(capturedTemp).toBe(0.4);
    expect(result).toBe('Custom adapted narration text.');
  });

  it('passes system instruction with directory tree and file structure verbalization rules', async () => {
    let capturedInstruction = '';
    const mockGenerateContent = mock(async ({ config }: any) => {
      capturedInstruction = config.systemInstruction;
      return { text: 'Adapted output' };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiNarrationAdapter(mockClient);
    await adapter.adaptForNarration('Some content');

    expect(capturedInstruction).toContain('Directory Trees & File Structures');
    expect(capturedInstruction).toContain('Never read raw ASCII tree characters');
    expect(capturedInstruction).toContain('Verbalize');
  });

  it('passes system instruction with code block and diagram verbalization rules', async () => {
    let capturedInstruction = '';
    const mockGenerateContent = mock(async ({ config }: any) => {
      capturedInstruction = config.systemInstruction;
      return { text: 'Adapted output' };
    });
    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiNarrationAdapter(mockClient);
    await adapter.adaptForNarration('Some content with ```mermaid flowchart TD');

    expect(capturedInstruction).toContain('Code Blocks & Snippets');
    expect(capturedInstruction).toContain('Mermaid & Architecture Diagrams');
    expect(capturedInstruction).toContain('Never read or emit raw diagram syntax');
    expect(capturedInstruction).toContain('Never include triple backticks');
  });
});
