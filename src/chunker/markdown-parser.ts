import { lexer, type Token, type Tokens } from 'marked';
import {
  isDiagramBlock,
  isDirectoryTree,
  parseMarkdownToSpeakableParagraphs,
  verbalizeDirectoryTree,
  type ParseMarkdownOptions,
} from './markdown-ast-parser.js';
import { sanitizeTextForSpeech } from './url-sanitizer.js';

export {
  isDiagramBlock,
  isDirectoryTree,
  parseMarkdownToSpeakableParagraphs,
  verbalizeDirectoryTree,
  type ParseMarkdownOptions,
};

export interface SpeakableSegment {
  text: string;
  mdStart: number;
  mdEnd: number;
}

function ensureSentenceEnding(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const lastChar = trimmed[trimmed.length - 1];
  if (
    lastChar === '.' ||
    lastChar === '!' ||
    lastChar === '?' ||
    lastChar === ':' ||
    lastChar === '—'
  ) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function extractTextFromTokens(tokens: Token[]): string {
  const parts: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const textToken = token as Tokens.Text;
        if (textToken.tokens && textToken.tokens.length > 0) {
          parts.push(extractTextFromTokens(textToken.tokens));
        } else {
          parts.push(textToken.text);
        }
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const parentToken = token as Tokens.Strong | Tokens.Em | Tokens.Del;
        if (parentToken.tokens && parentToken.tokens.length > 0) {
          parts.push(extractTextFromTokens(parentToken.tokens));
        } else if ('text' in parentToken && typeof parentToken.text === 'string') {
          parts.push(parentToken.text);
        }
        break;
      }
      case 'link': {
        const linkToken = token as Tokens.Link;
        let linkText = '';
        if (linkToken.tokens && linkToken.tokens.length > 0) {
          linkText = extractTextFromTokens(linkToken.tokens);
        } else if ('text' in linkToken && typeof linkToken.text === 'string') {
          linkText = linkToken.text;
        }

        if (/^https?:\/\//i.test(linkText.trim())) {
          linkText = '';
        }

        if (linkText) {
          parts.push(linkText);
        }
        break;
      }
      case 'image': {
        break;
      }
      case 'codespan': {
        const codeToken = token as Tokens.Codespan;
        parts.push(codeToken.text);
        break;
      }
      case 'list': {
        const listToken = token as Tokens.List;
        for (const item of listToken.items) {
          const itemText = extractTextFromTokens(item.tokens);
          if (itemText) parts.push(itemText);
        }
        break;
      }
      default: {
        if ('tokens' in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
          parts.push(extractTextFromTokens((token as { tokens: Token[] }).tokens));
        } else if ('text' in token && typeof (token as { text?: unknown }).text === 'string') {
          parts.push((token as { text: string }).text);
        }
        break;
      }
    }
  }

  return parts.join(' ');
}

/**
 * Extracts speakable segments from Markdown while recording each segment's
 * character span `[mdStart, mdEnd]` in the raw `markdownText` string.
 * Skips fenced code blocks, Mermaid diagram blocks, and raw HTML blocks.
 */
export function parseMarkdownToSpeakableSegments(
  markdownText: string,
  options?: ParseMarkdownOptions,
): SpeakableSegment[] {
  const tokens = lexer(markdownText);
  const segments: SpeakableSegment[] = [];
  const preserveHeadings = options?.preserveHeadings === true;
  let cursor = 0;

  for (const token of tokens) {
    const rawIdx = markdownText.indexOf(token.raw, cursor);
    const mdStart = rawIdx !== -1 ? rawIdx : cursor;
    const mdEnd = mdStart + token.raw.length;
    cursor = mdEnd;

    switch (token.type) {
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        if (isDirectoryTree(pToken.text)) {
          const treeParagraphs = verbalizeDirectoryTree(pToken.text);
          for (const p of treeParagraphs) {
            const rawText = sanitizeTextForSpeech(p);
            const text = ensureSentenceEnding(rawText);
            if (text.length > 0) {
              segments.push({ text, mdStart, mdEnd });
            }
          }
          break;
        }
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(pToken.tokens));
        const text = ensureSentenceEnding(rawText);
        if (text.length > 0) {
          segments.push({ text, mdStart, mdEnd });
        }
        break;
      }
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(hToken.tokens)).trim();
        if (rawText.length > 0) {
          if (preserveHeadings) {
            const depth = Math.min(3, Math.max(1, hToken.depth));
            const prefix = `${'#'.repeat(depth)} `;
            const cleanedHeading = rawText.replace(/[.]+$/, '');
            segments.push({ text: `${prefix}${cleanedHeading}`, mdStart, mdEnd });
          } else {
            const text = ensureSentenceEnding(rawText);
            if (text.length > 0) {
              segments.push({ text, mdStart, mdEnd });
            }
          }
        }
        break;
      }
      case 'list': {
        const listToken = token as Tokens.List;
        let itemCursor = 0;
        for (const item of listToken.items) {
          const itemRelIdx = listToken.raw.indexOf(item.raw, itemCursor);
          const itemStart = mdStart + (itemRelIdx !== -1 ? itemRelIdx : itemCursor);
          const itemEnd = itemStart + item.raw.length;
          itemCursor = (itemRelIdx !== -1 ? itemRelIdx : itemCursor) + item.raw.length;

          const rawText = sanitizeTextForSpeech(extractTextFromTokens(item.tokens));
          const itemText = ensureSentenceEnding(rawText);
          if (itemText.length > 0) {
            segments.push({ text: itemText, mdStart: itemStart, mdEnd: itemEnd });
          }
        }
        break;
      }
      case 'blockquote': {
        const quoteToken = token as Tokens.Blockquote;
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(quoteToken.tokens));
        const quoteText = ensureSentenceEnding(rawText);
        if (quoteText.length > 0) {
          segments.push({ text: quoteText, mdStart, mdEnd });
        }
        break;
      }
      case 'code':
      case 'html':
      default:
        break;
    }
  }

  return segments;
}
