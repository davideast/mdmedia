import type { DocumentChunk } from '../types/chunk.js';
import type { IFileReader } from '../types/platform.js';
import { parseMarkdownToSpeakableParagraphs } from './markdown-ast-parser.js';
import { parseMarkdownToStoryboardScenes, type StoryboardScene } from './storyboard-parser.js';
import { chunkSpeakableParagraphs } from './word-boundary-chunker.js';

export async function prepareDocumentChunks(
  fileReader: IFileReader,
  sourcePath: string,
  maxChunkChars?: number
): Promise<DocumentChunk[]> {
  const rawMarkdown = await fileReader.readText(sourcePath);
  const speakableParagraphs = parseMarkdownToSpeakableParagraphs(rawMarkdown);
  return chunkSpeakableParagraphs(speakableParagraphs, maxChunkChars);
}

export async function prepareStoryboardScenes(
  fileReader: IFileReader,
  sourcePath: string
): Promise<StoryboardScene[]> {
  const rawMarkdown = await fileReader.readText(sourcePath);
  return parseMarkdownToStoryboardScenes(rawMarkdown);
}

export * from './file-reader.js';
export * from './markdown-ast-parser.js';
export * from './markdown-mapper.js';
export * from './word-boundary-chunker.js';
export * from './url-sanitizer.js';
export * from './storyboard-parser.js';
