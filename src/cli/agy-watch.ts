import readline from 'node:readline';
import { GoogleGenAI } from '@google/genai';
import { createTTSProvider } from '../tts/provider-registry.js';
import { AudioLibrary } from '../storage/audio-library.js';
import { PlaybackEngine } from '../audio/player/playback-engine.js';
import { StudioStore } from '../studio/studio-store.js';
import { loadConfigFile } from '../config/config-loader.js';
import { resolveConfig } from '../config/config-resolver.js';
import { GeminiNarrationAdapter } from '../narration/gemini-narration-adapter.js';
import {
  getGeminiApiKey,
  getAllTranscriptSteps,
  getLatestPlannerResponseForConv,
} from '../studio/antigravity-watcher.js';
import { parseListenCommand } from './listen-parser.js';
import type { VoiceName } from '../types/voice.js';

async function main() {
  const requestedVoice = process.argv[2]?.trim()
    ? (process.argv[2] as VoiceName)
    : undefined;
  const requestedStyle = process.argv[3] || undefined;
  const geminiApiKey = process.env.GEMINI_API_KEY || getGeminiApiKey();
  const fileConfig = await loadConfigFile(process.cwd());
  const resolved = resolveConfig(
    { mode: 'audio', voice: requestedVoice, style: requestedStyle },
    fileConfig,
    { ...process.env, GEMINI_API_KEY: geminiApiKey }
  );
  const library = new AudioLibrary();
  const player = new PlaybackEngine();

  let narrationAdapter: GeminiNarrationAdapter | undefined;
  if (fileConfig?.narration?.enabled) {
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is required for narration rewriting.');
    narrationAdapter = new GeminiNarrationAdapter(new GoogleGenAI({ apiKey: geminiApiKey }), {
      model: fileConfig.narration.model,
    });
  }

  const defaultVoice =
    requestedVoice ??
    (resolved.audio.provider === 'gemini' && !fileConfig.audio?.voice
      ? 'Puck'
      : resolved.audio.voice);
  const defaultStyle =
    requestedStyle ?? resolved.audio.style ??
    (resolved.audio.provider === 'gemini'
      ? 'Clear, concise engineering assistant narration.'
      : undefined);
  const provider = createTTSProvider({
    provider: resolved.audio.provider,
    apiKey: resolved.apiKey,
    model: resolved.audio.model,
    voice: defaultVoice,
    style: defaultStyle,
    maxRetries: resolved.maxRetries,
  });

  const studioStore = new StudioStore({
    library,
    player,
    ttsProvider: provider,
    narrationAdapter,
    enableLiveAudio: true,
    defaultVoice,
    defaultStyle,
  });

  // Launch interactive OpenTUI terminal dashboard by default if in a TTY
  const isHeadless = process.argv.includes('--headless') || !process.stdin.isTTY;
  if (!isHeadless) {
    const { startStudioTui } = await import('../tui/app.js');
    await startStudioTui(studioStore);
    return;
  }

  const seenStepKeys = new Set<string>();
  const autoListenConversations = new Map<string, { voice?: VoiceName; style?: string }>();

  const initialSteps = getAllTranscriptSteps();
  for (const step of initialSteps) {
    seenStepKeys.add(step.key);
  }

  console.log(`🎧 [mdmedia watch] Ready! Scoped strictly to explicit /listen commands.`);
  console.log(`   - Type "/listen" in any conversation to narrate its latest response once`);
  console.log(`   - Type "/listen auto" (or "/listen auto -v Fenrir") to auto-narrate ONLY that session`);
  console.log(`   - Type "/listen off" to disable auto-narration for that session`);
  console.log(`   Controls: [Space] Pause/Resume  |  [s] Stop/Skip current  |  [q] Quit\n`);

  library.on('track:saved', (track) => {
    console.log(`💾 [Library] Saved "${track.title}" (${track.slug}) [${Math.round(track.durationMs / 1000)}s]`);
  });

  let isNarrating = false;
  const narrationQueue: {
    convId: string;
    stepIndex: number;
    content: string;
    voice?: VoiceName;
    style?: string;
  }[] = [];

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (_str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        studioStore.abortLiveTurn();
        player.stop();
        process.exit(0);
      }
      if (key.name === 'space') {
        studioStore.togglePause();
        const paused = studioStore.getState().playback.status === 'paused';
        console.log(paused ? '⏸  Audio Paused (press [Space] to resume)' : '▶  Audio Resumed');
      }
      if (key.name === 's') {
        studioStore.abortLiveTurn();
        player.stop();
        console.log('⏹  Stopped / skipped current message.');
      }
    });
  }

  async function processQueue() {
    if (isNarrating || narrationQueue.length === 0) return;
    const item = narrationQueue.shift()!;
    isNarrating = true;

    console.log(`\n🔊 Narrating response from session ${item.convId.slice(0, 8)} (step #${item.stepIndex})...`);

    try {
      await studioStore.handleLiveTurn({
        sessionId: item.convId,
        stepIndex: item.stepIndex,
        content: item.content,
        voice: item.voice,
        style: item.style,
      });
    } catch (err: any) {
      console.error(`[watch] Error narrating response:`, err.message);
    } finally {
      isNarrating = false;
      if (narrationQueue.length > 0) {
        processQueue();
      }
    }
  }

  setInterval(() => {
    const allSteps = getAllTranscriptSteps();
    const newSteps = allSteps.filter((s) => !seenStepKeys.has(s.key));

    for (const step of newSteps) {
      seenStepKeys.add(step.key);

      if (step.type === 'USER_INPUT') {
        const cmd = parseListenCommand(step.content);
        if (!cmd) continue;

        if (cmd.mode === 'auto') {
          autoListenConversations.set(step.convId, { voice: cmd.voice, style: cmd.style });
          console.log(`📌 [Session ${step.convId.slice(0, 8)}] Enabled "/listen auto" — new responses in this session will auto-narrate.`);
          const latestResp = getLatestPlannerResponseForConv(allSteps, step.convId);
          if (latestResp) {
            narrationQueue.push({
              convId: step.convId,
              stepIndex: latestResp.stepIndex,
              content: latestResp.content,
              voice: cmd.voice,
              style: cmd.style,
            });
          }
        } else if (cmd.mode === 'off') {
          autoListenConversations.delete(step.convId);
          studioStore.abortLiveTurn();
          player.stop();
          console.log(`🔕 [Session ${step.convId.slice(0, 8)}] Disabled auto-narration.`);
        } else if (cmd.mode === 'once') {
          console.log(`🎯 [Session ${step.convId.slice(0, 8)}] One-shot "/listen" requested — narrating latest response.`);
          const latestResp = getLatestPlannerResponseForConv(allSteps, step.convId);
          if (latestResp) {
            narrationQueue.push({
              convId: step.convId,
              stepIndex: latestResp.stepIndex,
              content: latestResp.content,
              voice: cmd.voice,
              style: cmd.style,
            });
          }
        }
      }

      if (step.type === 'PLANNER_RESPONSE') {
        const sessionOpts = autoListenConversations.get(step.convId);
        if (sessionOpts) {
          narrationQueue.push({
            convId: step.convId,
            stepIndex: step.stepIndex,
            content: step.content,
            voice: sessionOpts.voice,
            style: sessionOpts.style,
          });
        }
      }
    }

    processQueue();
  }, 1500);
}

main();
