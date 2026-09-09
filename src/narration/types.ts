export interface NarrationAdapterOptions {
  model?: string;
  systemInstruction?: string;
  temperature?: number;
}

export interface INarrationAdapter {
  adaptForNarration(markdown: string): Promise<string>;
}
