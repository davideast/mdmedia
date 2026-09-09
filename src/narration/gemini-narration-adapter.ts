import type { GoogleGenAI } from '@google/genai';
import { DEFAULT_NARRATION_SYSTEM_INSTRUCTION } from './system-instructions.js';
import type { INarrationAdapter, NarrationAdapterOptions } from './types.js';

export class GeminiNarrationAdapter implements INarrationAdapter {
  private readonly model: string;
  private readonly systemInstruction: string;
  private readonly temperature: number;

  constructor(
    private readonly client: GoogleGenAI,
    options: NarrationAdapterOptions = {}
  ) {
    this.model = options.model ?? 'gemini-3.5-flash-lite';
    this.systemInstruction = options.systemInstruction ?? DEFAULT_NARRATION_SYSTEM_INSTRUCTION;
    this.temperature = options.temperature ?? 0.2;
  }

  public async adaptForNarration(markdown: string): Promise<string> {
    const trimmed = markdown.trim();
    if (!trimmed) {
      return '';
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Transform the following technical markdown into an audio-narration-optimized script:\n\n${trimmed}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: this.systemInstruction,
        temperature: this.temperature,
      },
    });

    const rawText = response.text ?? '';
    return this.cleanGeneratedMarkdown(rawText);
  }

  private cleanGeneratedMarkdown(text: string): string {
    let cleaned = text.trim();
    // Strip accidental leading/trailing markdown fences (e.g., ```markdown ... ```)
    if (cleaned.startsWith('```markdown') || cleaned.startsWith('```md') || cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:markdown|md)?\r?\n/, '');
      cleaned = cleaned.replace(/\r?\n```$/, '');
    }
    return cleaned.trim();
  }
}
