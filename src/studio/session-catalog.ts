import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdownToSpeakableParagraphs } from '../chunker/markdown-ast-parser.js';
import type { AudioLibrary } from '../storage/audio-library.js';
import { generateTrackSlug } from '../storage/slugifier.js';
import type { TrackMetadata } from '../storage/types.js';
import { getBrainDir } from './antigravity-watcher.js';

export interface TurnItem {
  id: string;
  sessionId: string;
  stepIndex: number;
  title: string;
  markdown: string;
  wordCount: number;
  status: 'cached' | 'ungenerated' | 'synthesizing';
  track?: TrackMetadata;
  source?: 'turn' | 'document';
  filePath?: string;
}

export interface SessionCatalogOptions {
  brainDir?: string;
  workspaceDir?: string;
  library: AudioLibrary;
}

export interface SessionTurnFilter {
  query?: string;
  audioOnly?: boolean;
  limit?: number;
}

function findWorkspaceNarrationFiles(dir: string, maxDepth: number = 3): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.narration.md')) {
          results.push(fullPath);
        }
      }
    } catch {}
  }

  walk(dir, 0);
  return results;
}

function countWords(text: string): number {
  const speakableParagraphs = parseMarkdownToSpeakableParagraphs(text);
  let totalWords = 0;
  for (const para of speakableParagraphs) {
    const trimmed = para.trim();
    if (trimmed) {
      totalWords += trimmed.split(/\s+/).length;
    }
  }
  return totalWords;
}

interface CachedSessionEntry {
  mtimeMs: number;
  turns: Omit<TurnItem, 'status' | 'track'>[];
}

export class SessionCatalogService {
  private readonly brainDir: string;
  private readonly workspaceDir?: string;
  private readonly library: AudioLibrary;
  private readonly sessionCache = new Map<string, CachedSessionEntry>();

  constructor(options: SessionCatalogOptions) {
    this.brainDir = options.brainDir ?? getBrainDir();
    this.workspaceDir =
      options.workspaceDir !== undefined
        ? options.workspaceDir
        : options.brainDir
          ? undefined
          : process.cwd();
    this.library = options.library;
  }

  public listSessionTurns(filter?: SessionTurnFilter): TurnItem[] {
    const items: TurnItem[] = [];

    // Scan workspace for *.narration.md files if workspaceDir exists
    if (this.workspaceDir && fs.existsSync(this.workspaceDir)) {
      const narrationFiles = findWorkspaceNarrationFiles(this.workspaceDir);
      for (const filePath of narrationFiles) {
        try {
          const rel = path.relative(this.workspaceDir, filePath);
          const id = `doc_${rel.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const markdown = fs.readFileSync(filePath, 'utf8');
          const baseName = path.basename(filePath, '.narration.md');
          const { title } = generateTrackSlug(markdown, baseName);
          const cachedTrack = this.library.getTrack(id) ?? undefined;

          items.push({
            id,
            sessionId: 'workspace',
            stepIndex: 0,
            title: `[DOC] ${title}`,
            markdown,
            wordCount: countWords(markdown),
            status: cachedTrack ? 'cached' : 'ungenerated',
            track: cachedTrack,
            source: 'document',
            filePath,
          });
        } catch {}
      }
    }

    if (!fs.existsSync(this.brainDir)) {
      return items;
    }

    const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
    const convFiles: { convId: string; transcriptPath: string; mtimeMs: number }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptPath = path.join(
        this.brainDir,
        convId,
        '.system_generated/logs/transcript.jsonl'
      );
      try {
        const stat = fs.statSync(transcriptPath);
        convFiles.push({ convId, transcriptPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }

    // Sort conversations newest-modified first
    convFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Scan top 40 most recent conversations by default (or all if searching)
    const maxConvs = filter?.query ? convFiles.length : Math.min(convFiles.length, 40);

    for (let i = 0; i < maxConvs; i++) {
      const { convId, transcriptPath, mtimeMs } = convFiles[i];
      let cached = this.sessionCache.get(convId);

      if (!cached || cached.mtimeMs !== mtimeMs) {
        const parsedTurns: Omit<TurnItem, 'status' | 'track'>[] = [];
        try {
          const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
          for (const line of lines) {
            if (!line) continue;
            try {
              const step = JSON.parse(line);
              if (
                step.type === 'PLANNER_RESPONSE' &&
                typeof step.content === 'string' &&
                step.content.trim().length > 0
              ) {
                const stepIndex = Number(step.step_index);
                const id = `${convId.slice(0, 8)}_s${stepIndex}`;
                const markdown = step.content.trim();
                const { title } = generateTrackSlug(markdown, id);

                parsedTurns.push({
                  id,
                  sessionId: convId,
                  stepIndex,
                  title,
                  markdown,
                  wordCount: countWords(markdown),
                });
              }
            } catch {}
          }
          // Reverse within conversation so newest step in that conversation is first
          parsedTurns.reverse();
          cached = { mtimeMs, turns: parsedTurns };
          this.sessionCache.set(convId, cached);
        } catch {
          continue;
        }
      }

      for (const baseTurn of cached.turns) {
        const cachedTrack = this.library.getTrack(baseTurn.id) ?? undefined;
        items.push({
          ...baseTurn,
          status: cachedTrack ? 'cached' : 'ungenerated',
          track: cachedTrack,
        });
      }
    }

    let filtered = items;
    if (filter?.audioOnly) {
      filtered = filtered.filter((item) => item.status === 'cached');
    }
    if (filter?.query && filter.query.trim()) {
      const q = filter.query.toLowerCase().trim();
      filtered = filtered.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.sessionId.toLowerCase().includes(q) ||
          item.markdown.toLowerCase().includes(q)
      );
    }

    const limit = filter?.limit ?? 250;
    return filtered.slice(0, limit);
  }
}
