import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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
  isActive: boolean; // True if the Antigravity CLI session is open right now
  mtimeMs: number;
  turnCount: number;
  totalSteps: number;
  foldedStepCount: number;
  hasAudio: boolean;
  previewPrompt?: string;
  previewResponse?: string;
}

export interface SessionCatalogOptions {
  brainDir?: string;
  workspaceDir?: string;
  activeSessionIds?: Set<string>;
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

let cachedActiveCliSessions: Set<string> | null = null;
let lastActiveCliCheckMs = 0;

export function getActiveCliSessionIds(ttlMs: number = 2000): Set<string> {
  const now = Date.now();
  if (cachedActiveCliSessions && now - lastActiveCliCheckMs < ttlMs) {
    return cachedActiveCliSessions;
  }

  const activeIds = new Set<string>();
  const appName = path.basename(path.dirname(getBrainDir()));
  try {
    const out = execSync(`lsof -c "${appName}" -c antigravity 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 1500,
    });
    for (const line of out.split('\n')) {
      if (line.includes('presence') && line.includes('.lock')) {
        const match = line.match(/([a-f0-9-]{36})\.lock/);
        if (match) {
          activeIds.add(match[1]);
        }
      }
    }
  } catch (e: any) {
    const stdout = e.stdout ? String(e.stdout) : '';
    for (const line of stdout.split('\n')) {
      if (line.includes('presence') && line.includes('.lock')) {
        const match = line.match(/([a-f0-9-]{36})\.lock/);
        if (match) {
          activeIds.add(match[1]);
        }
      }
    }
  }

  cachedActiveCliSessions = activeIds;
  lastActiveCliCheckMs = now;
  return activeIds;
}

export function isSessionActive(convId: string, activeSessionIds?: Set<string>): boolean {
  const active = activeSessionIds ?? getActiveCliSessionIds();
  return active.has(convId);
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
  previewPrompt: string;
  previewResponse: string;
  totalSteps: number;
  foldedStepCount: number;
  turns: Omit<TurnItem, 'status' | 'track'>[];
}

export class SessionCatalogService {
  private readonly brainDir: string;
  private readonly workspaceDir?: string;
  private readonly activeSessionIds?: Set<string>;
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
    this.activeSessionIds = options.activeSessionIds;
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
      let previewPrompt = '';
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
              previewPrompt = clean.slice(0, 180);
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

      const previewResponse =
        parsedTurns.length > 0 ? parsedTurns[0].markdown.slice(0, 240) : '';

      cached = {
        mtimeMs,
        title: sessionTitle,
        previewPrompt,
        previewResponse,
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
    const activeCliIds = this.activeSessionIds ?? getActiveCliSessionIds();
    const candidateFiles: {
      convId: string;
      transcriptPath: string;
      mtimeMs: number;
      isActive: boolean;
    }[] = [];

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
        candidateFiles.push({
          convId,
          transcriptPath,
          mtimeMs: stat.mtimeMs,
          isActive: activeCliIds.has(convId),
        });
      } catch {}
    }

    // Sort: Active CLI sessions first, then Inactive sessions (both newest mtime first)
    candidateFiles.sort((a, b) => {
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1;
      }
      return b.mtimeMs - a.mtimeMs;
    });

    const maxCandidates = filter?.query ? candidateFiles.length : Math.min(candidateFiles.length, 50);

    for (let i = 0; i < maxCandidates; i++) {
      const { convId, transcriptPath, mtimeMs, isActive } = candidateFiles[i];
      try {
        const cached = this.parseSessionTranscript(convId, transcriptPath, mtimeMs);
        if (!cached) continue;

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
          mtimeMs,
          turnCount: cached.turns.length,
          totalSteps: cached.totalSteps,
          foldedStepCount: cached.foldedStepCount,
          hasAudio,
          previewPrompt: cached.previewPrompt,
          previewResponse: cached.previewResponse,
        });
      } catch {}
    }

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
