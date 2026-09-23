import type { GoogleGenAI } from '@google/genai';
import {
  buildMarkdownStructureSystemInstruction,
  DEFAULT_MARKDOWN_STRUCTURE_SYSTEM_INSTRUCTION,
} from './system-instructions.js';
import type {
  IMarkdownStructureAdapter,
  MarkdownStructureAdapterOptions,
  StructureMarkdownOptions,
} from './types.js';

export class GeminiMarkdownStructureAdapter implements IMarkdownStructureAdapter {
  private readonly model: string;
  private readonly baseSystemInstruction: string;
  private readonly customPrompt?: string;
  private readonly temperature: number;

  constructor(
    private readonly client: GoogleGenAI,
    options: MarkdownStructureAdapterOptions = {}
  ) {
    this.model = options.model ?? 'gemini-3.5-flash-lite';
    this.baseSystemInstruction =
      options.systemInstruction ?? DEFAULT_MARKDOWN_STRUCTURE_SYSTEM_INSTRUCTION;
    this.customPrompt = options.customPrompt;
    this.temperature = options.temperature ?? 0.1;
  }

  public async structureMarkdown(
    markdown: string,
    options?: StructureMarkdownOptions
  ): Promise<string> {
    const trimmed = markdown.trim();
    if (!trimmed) {
      return '';
    }

    const effectiveSystemInstruction = buildMarkdownStructureSystemInstruction(
      [this.customPrompt, options?.customPrompt],
      this.baseSystemInstruction
    );

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Clean and normalize the structure of the following technical Markdown according to your structural mandates, preserving all wording, code, and content exactly verbatim:\n\n${trimmed}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: effectiveSystemInstruction,
        temperature: this.temperature,
      },
    });

    const rawText = response.text ?? '';
    return this.cleanGeneratedMarkdown(rawText);
  }

  private cleanGeneratedMarkdown(text: string): string {
    let cleaned = text.trim();
    // Only strip if the model accidentally wrapped the entire output document
    // in an outer ```markdown or ```md fence. Handles both \n and \r\n line endings.
    const wrapperMatch = cleaned.match(/^```(?:markdown|md)\r?\n([\s\S]*?)\r?\n```$/);
    if (wrapperMatch) {
      cleaned = wrapperMatch[1];
    }
    return cleaned.trim();
  }
}
