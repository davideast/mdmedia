import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseMarkdownToSpeakableParagraphs } from '../chunker/markdown-ast-parser.js';
import { chunkSpeakableParagraphs } from '../chunker/word-boundary-chunker.js';
import { UniversalEventBus } from '../pipeline/pipeline-event-bus.js';
import { DocumentAudioPipeline } from '../pipeline/document-audio-pipeline.js';
import { createTTSProvider } from '../tts/provider-registry.js';
import { loadConfigFile } from '../config/config-loader.js';
import { resolveConfig } from '../config/config-resolver.js';
import { WavFileStreamSink } from '../audio/wav-file-stream-sink.js';
import { LiveAudioPlayerSink } from '../audio/live-audio-player-sink.js';
import { ChunkQueueAudioPlayer } from '../audio/player/chunk-queue-audio-player.js';
import { AudioLibrary } from '../storage/audio-library.js';
import { parseListenCommand } from '../cli/listen-parser.js';
import { getBrainDir, getGeminiApiKey } from '../studio/antigravity-watcher.js';
import type { VoiceName } from '../types/voice.js';

export function startNarratorSidecarServer(staticDir: string): void {
  const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 3456);
  const DATA_DIR =
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    path.join(os.tmpdir(), 'mdmedia-narrator');

  const BRAIN_DIR = getBrainDir();

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const LATEST_WAV_PATH = path.join(DATA_DIR, 'latest_narration.wav');
  const library = new AudioLibrary();

  function listConversations() {
    if (!fs.existsSync(BRAIN_DIR)) return [];
    const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    const conversations: {
      conversationId: string;
      updatedAt: number;
      plannerCount: number;
      preview: string;
    }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptPath = path.join(
        BRAIN_DIR,
        convId,
        '.system_generated/logs/transcript.jsonl'
      );
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const stat = fs.statSync(transcriptPath);
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        let lastPlannerMsg = '';
        let plannerCount = 0;

        for (const line of lines) {
          if (!line) continue;
          try {
            const step = JSON.parse(line);
            if (step.type === 'PLANNER_RESPONSE' && step.content) {
              plannerCount++;
              lastPlannerMsg = step.content;
            }
          } catch {}
        }

        if (plannerCount > 0) {
          conversations.push({
            conversationId: convId,
            updatedAt: stat.mtimeMs,
            plannerCount,
            preview: lastPlannerMsg.slice(0, 120).replace(/\n+/g, ' '),
          });
        }
      } catch {}
    }

    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    return conversations;
  }

  function getConversationMessages(conversationId: string) {
    const transcriptPath = path.join(
      BRAIN_DIR,
      conversationId,
      '.system_generated/logs/transcript.jsonl'
    );
    if (!fs.existsSync(transcriptPath)) return [];

    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    const messages: { stepIndex: number; createdAt?: string; content: string }[] = [];

    for (const line of lines) {
      if (!line) continue;
      try {
        const step = JSON.parse(line);
        if (
          step.type === 'PLANNER_RESPONSE' &&
          step.content &&
          step.content.trim().length > 0
        ) {
          messages.push({
            stepIndex: step.step_index,
            createdAt: step.created_at,
            content: step.content,
          });
        }
      } catch {}
    }

    return messages;
  }

  let activePlayer: ChunkQueueAudioPlayer | null = null;
  let activePipeline: DocumentAudioPipeline | null = null;

  async function narrateMarkdown({
    markdown,
    voice,
    style = '',
    playSpeaker = true,
  }: {
    markdown: string;
    voice?: VoiceName;
    style?: string;
    playSpeaker?: boolean;
  }) {
    const fileConfig = await loadConfigFile(process.cwd());
    const resolved = resolveConfig(
      { mode: 'audio', voice, style: style || undefined },
      fileConfig,
      { ...process.env, GEMINI_API_KEY: getGeminiApiKey() }
    );
    const selectedVoice =
      voice ??
      (resolved.audio.provider === 'gemini' && !fileConfig.audio?.voice
        ? 'Puck'
        : resolved.audio.voice);

    if (activePipeline) {
      activePipeline.abort();
      activePipeline = null;
    }
    if (activePlayer) {
      await activePlayer.stop().catch(() => {});
      activePlayer = null;
    }

    const speakableParagraphs = parseMarkdownToSpeakableParagraphs(markdown);
    const chunks = chunkSpeakableParagraphs(speakableParagraphs, 400);

    if (chunks.length === 0) {
      throw new Error('No speakable markdown content found in message.');
    }

    const eventBus = new UniversalEventBus();
    const wavSink = new WavFileStreamSink(LATEST_WAV_PATH);
    wavSink.attachToEventBus(eventBus);

    if (playSpeaker) {
      activePlayer = new ChunkQueueAudioPlayer();
      const liveSink = new LiveAudioPlayerSink(activePlayer);
      liveSink.attachToEventBus(eventBus);
    }

    const provider = createTTSProvider({
      provider: resolved.audio.provider,
      apiKey: resolved.apiKey,
      model: resolved.audio.model,
      voice: selectedVoice,
      style: resolved.audio.style,
      maxRetries: resolved.maxRetries,
    });
    activePipeline = new DocumentAudioPipeline(provider, eventBus);

    await activePipeline.processDocument(chunks, selectedVoice, resolved.audio.style);

    let savedTrackId: string | undefined;
    if (fs.existsSync(LATEST_WAV_PATH)) {
      try {
        const audioBuffer = fs.readFileSync(LATEST_WAV_PATH);
        const track = await library.saveTrack({
          sessionId: 'sidecar-web',
          stepIndex: Math.floor(Date.now() / 1000),
          markdown,
          audioBuffer,
          voice: selectedVoice,
          style: resolved.audio.style,
        });
        savedTrackId = track.id;
      } catch (err) {
        console.warn('[Sidecar] Failed to save track to library:', err);
      }
    }

    return {
      chunkCount: chunks.length,
      charCount: chunks.reduce((acc, c) => acc + c.charCount, 0),
      audioUrl: `/api/audio/latest.wav?t=${Date.now()}`,
      trackId: savedTrackId,
    };
  }

  // Per-Conversation /listen and /listen auto Watcher
  const seenStepKeys = new Set<string>();
  const autoListenConversations = new Map<
    string,
    { voice?: VoiceName; style?: string }
  >();
  let isAutoNarrating = false;

  function getAllTranscriptSteps() {
    if (!fs.existsSync(BRAIN_DIR)) return [];
    const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    const steps: {
      key: string;
      convId: string;
      stepIndex: number;
      type: string;
      content: string;
    }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const tPath = path.join(
        BRAIN_DIR,
        convId,
        '.system_generated/logs/transcript.jsonl'
      );
      if (!fs.existsSync(tPath)) continue;

      try {
        const lines = fs.readFileSync(tPath, 'utf8').trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            const step = JSON.parse(line);
            if (
              (step.type === 'USER_INPUT' || step.type === 'PLANNER_RESPONSE') &&
              step.content
            ) {
              steps.push({
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
    return steps;
  }

  for (const step of getAllTranscriptSteps()) {
    seenStepKeys.add(step.key);
  }

  let autoWatchState = {
    enabled: true,
    voice: 'Puck' as VoiceName,
    style: '',
  };

  setInterval(async () => {
    if (isAutoNarrating) return;
    try {
      const allSteps = getAllTranscriptSteps();
      const newSteps = allSteps.filter((s) => !seenStepKeys.has(s.key));
      let targetToNarrate: { content: string; voice?: VoiceName; style?: string } | null =
        null;

      for (const step of newSteps) {
        seenStepKeys.add(step.key);

        if (step.type === 'USER_INPUT') {
          const cmd = parseListenCommand(step.content);
          if (!cmd) continue;

          if (cmd.mode === 'auto') {
            autoListenConversations.set(step.convId, {
              voice: cmd.voice,
              style: cmd.style,
            });
            const latestResp = [...allSteps]
              .reverse()
              .find((s) => s.convId === step.convId && s.type === 'PLANNER_RESPONSE');
            if (latestResp) {
              targetToNarrate = {
                content: latestResp.content,
                voice: cmd.voice,
                style: cmd.style,
              };
            }
          } else if (cmd.mode === 'off') {
            autoListenConversations.delete(step.convId);
            if (activePipeline) activePipeline.abort();
            if (activePlayer) activePlayer.stop().catch(() => {});
          } else if (cmd.mode === 'once') {
            const latestResp = [...allSteps]
              .reverse()
              .find((s) => s.convId === step.convId && s.type === 'PLANNER_RESPONSE');
            if (latestResp) {
              targetToNarrate = {
                content: latestResp.content,
                voice: cmd.voice,
                style: cmd.style,
              };
            }
          }
        }

        if (step.type === 'PLANNER_RESPONSE') {
          const sessionOpts = autoListenConversations.get(step.convId);
          if (sessionOpts) {
            targetToNarrate = {
              content: step.content,
              voice: sessionOpts.voice,
              style: sessionOpts.style,
            };
          }
        }
      }

      if (targetToNarrate) {
        isAutoNarrating = true;
        try {
          await narrateMarkdown({
            markdown: targetToNarrate.content,
            voice: targetToNarrate.voice || autoWatchState.voice,
            style: targetToNarrate.style ?? autoWatchState.style,
            playSpeaker: true,
          });
        } finally {
          isAutoNarrating = false;
        }
      }
    } catch (err: any) {
      console.error('[Sidecar Watcher] Error:', err.message);
    }
  }, 2000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (
        req.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/index.html')
      ) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/styles.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(fs.readFileSync(path.join(staticDir, 'styles.css'), 'utf8'));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(`window.sidecar = window.sidecar || { conversationId: null };`);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        const conversations = listConversations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversations, autoWatchState }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const convId = url.searchParams.get('conversationId');
        const messages = convId ? getConversationMessages(convId) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversationId: convId, messages }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/audio/latest.wav') {
        if (!fs.existsSync(LATEST_WAV_PATH)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No audio generated yet' }));
          return;
        }
        const stat = fs.statSync(LATEST_WAV_PATH);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': stat.size,
        });
        fs.createReadStream(LATEST_WAV_PATH).pipe(res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/library/tracks') {
        const tracks = library.listTracks();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tracks }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/library/audio') {
        const trackId = url.searchParams.get('id');
        const track = trackId ? library.getTrack(trackId) : null;
        if (!track || !fs.existsSync(track.audioPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Track audio not found' }));
          return;
        }
        const stat = fs.statSync(track.audioPath);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': stat.size,
        });
        fs.createReadStream(track.audioPath).pipe(res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/narrate') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body || '{}');

        const result = await narrateMarkdown({
          markdown: payload.markdown,
          voice: payload.voice || 'Puck',
          style: payload.style || '',
          playSpeaker: payload.playSpeaker !== false,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pause') {
        const paused = activePlayer?.togglePause ? activePlayer.togglePause() : false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', paused }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (activePipeline) {
          activePipeline.abort();
          activePipeline = null;
        }
        if (activePlayer) {
          await activePlayer.stop().catch(() => {});
          activePlayer = null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'stopped' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auto-watch') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body || '{}');

        autoWatchState = {
          ...autoWatchState,
          enabled: Boolean(payload.enabled),
          voice: payload.voice || autoWatchState.voice,
          style: payload.style ?? autoWatchState.style,
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', autoWatchState }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err: any) {
      console.error('[Sidecar Error]:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  });

  server.listen(PORT, () => {
    console.log(`[mdmedia_narrator] Sidecar UI plugin listening on http://localhost:${PORT}`);
  });
}
