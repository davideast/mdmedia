export interface NarrationAdapterOptions {
  model?: string;
  /**
   * Base system instruction override. Defaults to `DEFAULT_NARRATION_SYSTEM_INSTRUCTION`.
   */
  systemInstruction?: string;
  /**
   * Customizable prompt extension appended to the system instruction without
   * replacing the core markdown-to-narration rules (for example, to generate
   * section headings or tailor structural output).
   */
  customPrompt?: string;
  temperature?: number;
}

export interface AdaptForNarrationOptions {
  /**
   * Per-call customizable prompt extension appended to the adapter's system instruction.
   */
  customPrompt?: string;
}

export interface INarrationAdapter {
  adaptForNarration(markdown: string, options?: AdaptForNarrationOptions): Promise<string>;
}
