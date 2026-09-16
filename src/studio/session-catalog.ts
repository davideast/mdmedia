import fs from 'node:fs';
import path from 'node:path';
import { lexer } from 'marked';
import { parseMarkdownToSpeakableParagraphs } from '../chunker/markdown-ast-parser.js';
import type { AudioLibrary } from '../storage/audio-library.js';
import { generateTrackSlug } from '../storage/slugifier.js';
import type { TrackMetadata } from '../storage/types.js';
import { getBrainDir } from './antigravity-watcher.js';

export interface FoldedStep {
  stepIndex: number;
  content: string;
}

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
  foldedStepCount?: number;
  foldedSteps?: FoldedStep[];
}

export interface SessionItem {
  id: string;
  shortId: string;
  title: string;
  isActive: boolean;
  mtimeMs: number;
  turnCount: number;
  totalSteps: number;
  foldedStepCount: number;
  hasAudio: boolean;
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

export interface SessionFilter {
  query?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface SubstantiveClassificationOptions {
  minWords?: number;
  minWordsWithStructure?: number;
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

export function isSubstantiveResponse(
  content: string,
  hasToolCalls: boolean,
  options: SubstantiveClassificationOptions = {}
): boolean {
  if (!content || !content.trim()) return false;
  const words = countWords(content);
  // In-flight tool calls -> intermediate step unless substantial explanation
  if (hasToolCalls && words < 150) {
    return false;
  }

  const minWords = options.minWords ?? 30;
  if (words >= minWords) {
    return true;
  }

  const tokens = lexer(content);
  const hasStructure = tokens.some(
    (t) => t.type === 'heading' || t.type === 'table' || t.type === 'list'
  );
  if (hasStructure) {
    return true;
  }

  return false;
}

export function isSessionActive(
  transcriptPath: string,
  statMtimeMs: number,
  nowMs: number = Date.now(),
  activeThresholdMs: number = 90_000
): boolean {
  const ageMs = nowMs - statMtimeMs;
  if (ageMs > activeThresholdMs) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8').trim();
    if (!content) return false;
    const lastNewline = content.lastIndexOf('\n');
    const lastLine = lastNewline !== -1 ? content.slice(lastNewline + 1) : content;
    if (!lastLine.trim()) return false;

    const step = JSON.parse(lastLine);
    if (step.status === 'RUNNING') return true;
    if (step.type === 'USER_INPUT') return true;
    if (step.type === 'GENERIC') return true;
    if (
      step.type === 'PLANNER_RESPONSE' &&
      Array.isArray(step.tool_calls) &&
      step.tool_calls.length > 0
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
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

interface CachedSessionEntry {
  mtimeMs: number;
  title: string;
  totalSteps: number;
  foldedStepCount: number;
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

  private parseSessionTranscript(
    convId: string,
    transcriptPath: string,
    mtimeMs: number
  ): CachedSessionEntry | null {
    let cached = this.sessionCache.get(convId);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    try {
      const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
      let promptTitle = '';
      let pendingFolded: FoldedStep[] = [];
      const parsedTurns: Omit<TurnItem, 'status' | 'track'>[] = [];
      let totalSteps = 0;
      let totalFolded = 0;

      for (const line of lines) {
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          totalSteps++;
          if (step.type === 'USER_INPUT' && typeof step.content === 'string') {
            if (!promptTitle) {
              const clean = step.content
                .trim()
                .replace(/^<USER_REQUEST>\s*/, '')
                .replace(/\s*<\/USER_REQUEST>$/, '');
              promptTitle = clean.slice(0, 60);
            }
          } else if (
            step.type === 'PLANNER_RESPONSE' &&
            typeof step.content === 'string' &&
            step.content.trim().length > 0
          ) {
            const stepIndex = Number(step.step_index);
            const markdown = step.content.trim();
            const hasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;

            if (isSubstantiveResponse(markdown, hasToolCalls)) {
              const id = `${convId.slice(0, 8)}_s${stepIndex}`;
              const { title } = generateTrackSlug(markdown, id);

              parsedTurns.push({
                id,
                sessionId: convId,
                stepIndex,
                title,
                markdown,
                wordCount: countWords(markdown),
                foldedStepCount: pendingFolded.length,
                foldedSteps: pendingFolded.length > 0 ? [...pendingFolded] : undefined,
              });
              totalFolded += pendingFolded.length;
              pendingFolded = [];
            } else {
              pendingFolded.push({ stepIndex, content: markdown });
            }
          }
        } catch {}
      }

      // If no substantive turns were found, keep the last message as a fallback turn
      if (parsedTurns.length === 0 && pendingFolded.length > 0) {
        const last = pendingFolded[pendingFolded.length - 1];
        const id = `${convId.slice(0, 8)}_s${last.stepIndex}`;
        const { title } = generateTrackSlug(last.content, id);
        parsedTurns.push({
          id,
          sessionId: convId,
          stepIndex: last.stepIndex,
          title,
          markdown: last.content,
          wordCount: countWords(last.content),
          foldedStepCount: pendingFolded.length - 1,
          foldedSteps: pendingFolded.slice(0, -1),
        });
        totalFolded += pendingFolded.length - 1;
      }

      parsedTurns.reverse();
      const sessionTitle =
        promptTitle ||
        (parsedTurns.length > 0 ? parsedTurns[0].title : `Session ${convId.slice(0, 8)}`);

      cached = {
        mtimeMs,
        title: sessionTitle,
        totalSteps,
        foldedStepCount: totalFolded,
        turns: parsedTurns,
      };
      this.sessionCache.set(convId, cached);
      return cached;
    } catch {
      return null;
    }
  }

  public listSessions(filter?: SessionFilter): SessionItem[] {
    const sessions: SessionItem[] = [];

    if (!fs.existsSync(this.brainDir)) {
      return sessions;
    }

    const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
    const now = Date.now();

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
        const cached = this.parseSessionTranscript(convId, transcriptPath, stat.mtimeMs);
        if (!cached) continue;

        const isActive = isSessionActive(transcriptPath, stat.mtimeMs, now);
        let hasAudio = false;
        for (const turn of cached.turns) {
          if (this.library.getTrack(turn.id)) {
            hasAudio = true;
            break;
          }
        }

        sessions.push({
          id: convId,
          shortId: convId.slice(0, 8),
          title: cached.title,
          isActive,
          mtimeMs: stat.mtimeMs,
          turnCount: cached.turns.length,
          totalSteps: cached.totalSteps,
          foldedStepCount: cached.foldedStepCount,
          hasAudio,
        });
      } catch {}
    }

    // Sort: Active first (newest mtime first), then Idle (newest mtime first)
    sessions.sort((a, b) => {
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1;
      }
      return b.mtimeMs - a.mtimeMs;
    });

    let filtered = sessions;
    if (filter?.activeOnly) {
      filtered = filtered.filter((s) => s.isActive);
    }
    if (filter?.query && filter.query.trim()) {
      const q = filter.query.toLowerCase().trim();
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.shortId.toLowerCase().includes(q)
      );
    }

    const limit = filter?.limit ?? 100;
    return filtered.slice(0, limit);
  }

  public getSessionTurns(sessionId: string, filter?: SessionTurnFilter): TurnItem[] {
    if (sessionId === 'workspace') {
      return this.listWorkspaceDocumentTurns(filter);
    }

    const transcriptPath = path.join(
      this.brainDir,
      sessionId,
      '.system_generated/logs/transcript.jsonl'
    );
    try {
      const stat = fs.statSync(transcriptPath);
      const cached = this.parseSessionTranscript(sessionId, transcriptPath, stat.mtimeMs);
      if (!cached) return [];

      let turns: TurnItem[] = cached.turns.map((baseTurn) => {
        const cachedTrack = this.library.getTrack(baseTurn.id) ?? undefined;
        return {
          ...baseTurn,
          status: cachedTrack ? 'cached' : 'ungenerated',
          track: cachedTrack,
        };
      });

      if (filter?.audioOnly) {
        turns = turns.filter((t) => t.status === 'cached');
      }
      if (filter?.query && filter.query.trim()) {
        const q = filter.query.toLowerCase().trim();
        turns = turns.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.sessionId.toLowerCase().includes(q) ||
            t.markdown.toLowerCase().includes(q)
        );
      }

      const limit = filter?.limit ?? 250;
      return turns.slice(0, limit);
    } catch {
      return [];
    }
  }

  private listWorkspaceDocumentTurns(filter?: SessionTurnFilter): TurnItem[] {
    const items: TurnItem[] = [];
    if (!this.workspaceDir || !fs.existsSync(this.workspaceDir)) {
      return items;
    }

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

  public listSessionTurns(filter?: SessionTurnFilter): TurnItem[] {
    const items: TurnItem[] = [];

    // 1. Include workspace documents
    items.push(...this.listWorkspaceDocumentTurns(filter));

    // 2. Include sessions
    const sessions = this.listSessions();
    for (const session of sessions) {
      const sessionTurns = this.getSessionTurns(session.id, filter);
      items.push(...sessionTurns);
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
