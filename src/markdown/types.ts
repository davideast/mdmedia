export interface MarkdownStructureAdapterOptions {
  model?: string;
  /**
   * Base system instruction override. Defaults to `DEFAULT_MARKDOWN_STRUCTURE_SYSTEM_INSTRUCTION`.
   */
  systemInstruction?: string;
  /**
   * Customizable prompt extension appended to the system instruction without
   * replacing the core structural cleanup rules.
   */
  customPrompt?: string;
  temperature?: number;
}

export interface StructureMarkdownOptions {
  /**
   * Per-call customizable prompt extension appended to the adapter's system instruction.
   */
  customPrompt?: string;
}

export interface IMarkdownStructureAdapter {
  structureMarkdown(markdown: string, options?: StructureMarkdownOptions): Promise<string>;
}
