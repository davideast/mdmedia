import { lexer, type Token, type Tokens } from 'marked';
import { sanitizeTextForSpeech } from './url-sanitizer.js';

function ensureSentenceEnding(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar === '.' || lastChar === '!' || lastChar === '?' || lastChar === ':' || lastChar === '—') {
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

        // If the anchor text is just the raw URL itself (e.g. [https://...](https://...)), discard it
        if (/^https?:\/\//i.test(linkText.trim())) {
          linkText = '';
        }

        if (linkText) {
          parts.push(linkText);
        }
        break;
      }
      case 'image': {
        // Discard raw markdown image references in spoken speech
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
        if ('tokens' in token && Array.isArray((token as any).tokens)) {
          parts.push(extractTextFromTokens((token as any).tokens));
        } else if ('text' in token && typeof token.text === 'string') {
          parts.push(token.text);
        }
        break;
      }
    }
  }

  return parts.join(' ');
}

/**
 * Detects if a text block represents an ASCII directory/file tree.
 */
export function isDirectoryTree(text: string): boolean {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;

  const treeChars = /[├──└──│┌┐└┘├┤┬┴┼─]/;
  const asciiBranch = /^\s*(?:\|--|\+--|`--|\\--|\||\+-)/;

  let branchCount = 0;
  for (const line of lines) {
    if (treeChars.test(line) || asciiBranch.test(line)) {
      branchCount++;
    }
  }

  return (
    branchCount >= 2 ||
    (lines.length >= 2 && branchCount >= 1 && (lines[0].endsWith('/') || lines[0].startsWith('.')))
  );
}

function cleanSpokenPathSegment(name: string): string {
  let s = name.replace(/[/\\]+$/, '').trim();
  if (s === '.') return 'current directory';
  s = s.replace(/^\.\//, '');
  s = s.replace(/<([^>]+)>/g, '$1');
  s = s.replace(/^\./, 'dot-');
  s = s.replace(/\/\./g, ' slash dot-');
  s = s.replace(/\//g, ' slash ');
  s = s.replace(/\.([a-zA-Z0-9]+)$/, ' dot $1');
  return s;
}

function formatSpokenList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const isDirectoryEntry = (name: string): boolean =>
  name.endsWith('/') || !/\.[a-zA-Z0-9]+$/.test(name);

/**
 * Verbalizes an ASCII directory/file tree into natural spoken paragraphs
 * describing the number of levels, the root directory, and major subdirectories.
 */
export function verbalizeDirectoryTree(text: string): string[] {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const rootLine = lines[0].replace(/^[#\s*`]+|[#\s*`]+$/g, '').trim();
  const rootName = rootLine.replace(/[/\\]+$/, '');

  interface TreeItem {
    name: string;
    comment: string;
    depth: number;
  }

  const items: TreeItem[] = [];
  let maxDepth = 1;

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    let namePart = rawLine;
    let comment = '';
    const hashIdx = rawLine.indexOf('#');
    const slashSlashIdx = rawLine.indexOf('//');
    const commentIdx = hashIdx !== -1 ? hashIdx : slashSlashIdx;
    if (commentIdx !== -1) {
      namePart = rawLine.slice(0, commentIdx);
      comment = rawLine.slice(commentIdx + 1).replace(/^[/ ]+/, '').trim();
    }

    const branchMatch = namePart.match(/^([│\s|`+\\-]*(?:├──|└──|\|--|`--|\+--|\\--))\s*(.*)$/);
    let cleanName = '';
    let depth = 2;

    if (branchMatch) {
      const prefix = branchMatch[1];
      cleanName = branchMatch[2].trim();
      const segmentCount = (
        prefix.match(/├──|└──|\|--|`--|\+--|\\--|│\s{3}|\|\s{3}|\s{4}/g) || []
      ).length;
      depth = Math.max(2, 1 + segmentCount);
    } else {
      cleanName = namePart.replace(/^[│\s|`+\\-]+/, '').trim();
      const leadingSpaces = namePart.search(/\S|$/);
      depth = Math.max(2, 2 + Math.floor(leadingSpaces / 4));
    }

    if (cleanName) {
      if (depth > maxDepth) maxDepth = depth;
      items.push({ name: cleanName, comment, depth });
    }
  }

  const spokenRoot = cleanSpokenPathSegment(rootName);
  if (items.length === 0) {
    return [`The directory structure has 1 level, with root directory ${spokenRoot}.`];
  }

  interface Section {
    parent: TreeItem;
    children: TreeItem[];
  }
  const sections: Section[] = [];
  let currentSec: Section | null = null;

  for (const item of items) {
    if (item.depth === 2 || !currentSec) {
      currentSec = { parent: item, children: [] };
      sections.push(currentSec);
    } else {
      currentSec.children.push(item);
    }
  }

  const dirNames = sections
    .filter((s) => isDirectoryEntry(s.parent.name))
    .map((s) => cleanSpokenPathSegment(s.parent.name));
  const fileNames = sections
    .filter((s) => !isDirectoryEntry(s.parent.name))
    .map((s) => cleanSpokenPathSegment(s.parent.name));

  let overview = `The directory structure has ${maxDepth} levels, the top directory name being ${spokenRoot}`;
  if (dirNames.length > 0 && fileNames.length > 0) {
    overview += `, with subdirectories for ${formatSpokenList(dirNames)}, alongside ${formatSpokenList(fileNames)}.`;
  } else if (dirNames.length > 0) {
    overview += `, with subdirectories for ${formatSpokenList(dirNames)}.`;
  } else if (fileNames.length > 0) {
    overview += `, with files for ${formatSpokenList(fileNames)}.`;
  } else {
    overview += '.';
  }

  const paragraphs: string[] = [overview];

  for (const sec of sections) {
    const parentSpoken = cleanSpokenPathSegment(sec.parent.name);
    let desc = `Under ${parentSpoken}`;
    if (sec.parent.comment) {
      desc += ` for ${sec.parent.comment}`;
    }
    if (sec.children.length > 0) {
      const childList = sec.children.map((c) => {
        let n = cleanSpokenPathSegment(c.name);
        if (c.comment) {
          n += ` for ${c.comment}`;
        }
        return n;
      });
      if (childList.length <= 4) {
        desc += `, contents include ${childList.join(', ')}.`;
      } else {
        const first = childList.slice(0, 3).join(', ');
        desc += `, contents include ${first}, and ${childList.length - 3} other files and folders.`;
      }
      paragraphs.push(desc);
    } else if (sec.parent.comment) {
      paragraphs.push(`${desc}.`);
    }
  }

  return paragraphs;
}

export function parseMarkdownToSpeakableParagraphs(markdownText: string): string[] {
  const tokens = lexer(markdownText);
  const paragraphs: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph': {
        const pToken = token as Tokens.Paragraph;
        if (isDirectoryTree(pToken.text)) {
          const treeParagraphs = verbalizeDirectoryTree(pToken.text);
          for (const p of treeParagraphs) {
            const rawText = sanitizeTextForSpeech(p);
            const text = ensureSentenceEnding(rawText);
            if (text.length > 0) {
              paragraphs.push(text);
            }
          }
          break;
        }
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(pToken.tokens));
        const text = ensureSentenceEnding(rawText);
        if (text.length > 0) {
          paragraphs.push(text);
        }
        break;
      }
      case 'heading': {
        const hToken = token as Tokens.Heading;
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(hToken.tokens));
        const text = ensureSentenceEnding(rawText);
        if (text.length > 0) {
          paragraphs.push(text);
        }
        break;
      }
      case 'list': {
        const listToken = token as Tokens.List;
        for (const item of listToken.items) {
          const rawText = sanitizeTextForSpeech(extractTextFromTokens(item.tokens));
          const itemText = ensureSentenceEnding(rawText);
          if (itemText.length > 0) {
            paragraphs.push(itemText);
          }
        }
        break;
      }
      case 'blockquote': {
        const quoteToken = token as Tokens.Blockquote;
        const rawText = sanitizeTextForSpeech(extractTextFromTokens(quoteToken.tokens));
        const quoteText = ensureSentenceEnding(rawText);
        if (quoteText.length > 0) {
          paragraphs.push(quoteText);
        }
        break;
      }
      case 'code': {
        const codeToken = token as Tokens.Code;
        if (isDirectoryTree(codeToken.text)) {
          const treeParagraphs = verbalizeDirectoryTree(codeToken.text);
          for (const p of treeParagraphs) {
            const rawText = sanitizeTextForSpeech(p);
            const text = ensureSentenceEnding(rawText);
            if (text.length > 0) {
              paragraphs.push(text);
            }
          }
        } else {
          const codeText = sanitizeTextForSpeech(codeToken.text);
          if (codeText.length > 0) {
            paragraphs.push(`Code snippet: ${codeText}.`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return paragraphs;
}
