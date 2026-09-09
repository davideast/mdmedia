import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseListenCommand } from '../cli/listen-parser.js';
import type { StudioStore } from './studio-store.js';
import type { VoiceName } from '../types/voice.js';

export function getBrainDir(): string {
  if (process.env.ANTIGRAVITY_BRAIN_DIR) return process.env.ANTIGRAVITY_BRAIN_DIR;
  const geminiDir = path.join(os.homedir(), '.gemini');
  const defaultPath = path.join(geminiDir, 'antigravity/brain');
  if (fs.existsSync(defaultPath)) return defaultPath;

  if (fs.existsSync(geminiDir)) {
    try {
      for (const entry of fs.readdirSync(geminiDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const candidate = path.join(geminiDir, entry.name, 'brain');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch {}
  }

  return defaultPath;
}

export function getGeminiApiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const homeEnv = path.join(os.homedir(), '.gemini/.env');
  if (fs.existsSync(homeEnv)) {
    const content = fs.readFileSync(homeEnv, 'utf8');
    const match = content.match(/GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/);
    if (match) return match[1].trim();
  }
  return '';
}

export interface TranscriptStep {
  key: string;
  convId: string;
  stepIndex: number;
  type: 'USER_INPUT' | 'PLANNER_RESPONSE' | string;
  content: string;
}

export function getAllTranscriptSteps(brainDir: string = getBrainDir()): TranscriptStep[] {
  if (!fs.existsSync(brainDir)) return [];
  const entries = fs.readdirSync(brainDir, { withFileTypes: true });
  const results: TranscriptStep[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const convId = entry.name;
    const tPath = path.join(brainDir, convId, '.system_generated/logs/transcript.jsonl');
    if (!fs.existsSync(tPath)) continue;

    try {
      const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          if (
            (step.type === 'USER_INPUT' || step.type === 'PLANNER_RESPONSE') &&
            typeof step.content === 'string' &&
            step.content.trim()
          ) {
            results.push({
              key: `${convId}:${step.step_index}`,
              convId,
              stepIndex: step.step_index,
              type: step.type,
              content: step.content.trim(),
            });
          }
        } catch {}
      }
    } catch {}
  }

  return results;
}

export function getLatestPlannerResponseForConv(
  steps: TranscriptStep[],
  convId: string
): TranscriptStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].convId === convId && steps[i].type === 'PLANNER_RESPONSE') {
      return steps[i];
    }
  }
  return null;
}

export interface AntigravityWatcherOptions {
  pollIntervalMs?: number;
  defaultVoice?: VoiceName;
  defaultStyle?: string;
  onLog?: (message: string) => void;
}

export class AntigravityWatcher {
  private timer?: Timer;
  private readonly seenStepKeys = new Set<string>();
  private readonly autoListenConversations = new Map<string, { voice?: VoiceName; style?: string }>();
  private readonly brainDir: string;
  private readonly pollIntervalMs: number;
  private readonly defaultVoice: VoiceName;
  private readonly defaultStyle?: string;
  private readonly onLog: (message: string) => void;

  constructor(
    private readonly store: StudioStore,
    options: AntigravityWatcherOptions = {}
  ) {
    this.brainDir = getBrainDir();
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.defaultVoice = options.defaultVoice ?? 'Puck';
    this.defaultStyle = options.defaultStyle;
    this.onLog = options.onLog ?? (() => {});

    // Mark existing steps as seen so we don't replay history on startup
    const initialSteps = getAllTranscriptSteps(this.brainDir);
    for (const step of initialSteps) {
      this.seenStepKeys.add(step.key);
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    try {
      const allSteps = getAllTranscriptSteps(this.brainDir);
      const newSteps = allSteps.filter((s) => !this.seenStepKeys.has(s.key));

      for (const step of newSteps) {
        this.seenStepKeys.add(step.key);

        if (step.type === 'USER_INPUT') {
          const cmd = parseListenCommand(step.content);
          if (!cmd) continue;

          if (cmd.mode === 'auto') {
            this.autoListenConversations.set(step.convId, { voice: cmd.voice, style: cmd.style });
            this.onLog(`📌 [Session ${step.convId.slice(0, 8)}] Enabled "/listen auto"`);
            const latestResp = getLatestPlannerResponseForConv(allSteps, step.convId);
            if (latestResp) {
              this.store.handleLiveTurn({
                sessionId: step.convId,
                stepIndex: latestResp.stepIndex,
                content: latestResp.content,
                voice: cmd.voice || this.defaultVoice,
                style: cmd.style ?? this.defaultStyle,
              }).catch((err) => {
                this.onLog(`[Watcher Error]: ${err.message}`);
              });
            }
          } else if (cmd.mode === 'off') {
            this.autoListenConversations.delete(step.convId);
            this.store.abortLiveTurn();
            this.onLog(`🔕 [Session ${step.convId.slice(0, 8)}] Disabled auto-narration.`);
          } else if (cmd.mode === 'generate') {
            this.onLog(
              `📝 [Session ${step.convId.slice(0, 8)}] Narration generation requested (/listen generate${
                cmd.targetPath ? ` ${cmd.targetPath}` : ''
              }) - handled by Agent via subscription`
            );
          } else if (cmd.mode === 'once') {
            this.onLog(`🎯 [Session ${step.convId.slice(0, 8)}] One-shot /listen requested`);
            const latestResp = getLatestPlannerResponseForConv(allSteps, step.convId);
            if (latestResp) {
              this.store.handleLiveTurn({
                sessionId: step.convId,
                stepIndex: latestResp.stepIndex,
                content: latestResp.content,
                voice: cmd.voice || this.defaultVoice,
                style: cmd.style ?? this.defaultStyle,
              }).catch((err) => {
                this.onLog(`[Watcher Error]: ${err.message}`);
              });
            }
          }
        }

        if (step.type === 'PLANNER_RESPONSE') {
          const sessionOpts = this.autoListenConversations.get(step.convId);
          if (sessionOpts) {
            this.store.handleLiveTurn({
              sessionId: step.convId,
              stepIndex: step.stepIndex,
              content: step.content,
              voice: sessionOpts.voice || this.defaultVoice,
              style: sessionOpts.style ?? this.defaultStyle,
            }).catch((err) => {
              this.onLog(`[Watcher Error]: ${err.message}`);
            });
          }
        }
      }
    } catch (err: any) {
      this.onLog(`[Watcher Poll Error]: ${err.message}`);
    }
  }
}
