import { AudioLibrary } from '../storage/audio-library.js';
import { PlaybackEngine } from '../audio/player/playback-engine.js';
import { extractWordTimingsFromPcm } from '../audio/player/word-aligner.js';
import { parseMarkdownToSpeakableParagraphs } from '../chunker/markdown-ast-parser.js';
import { chunkSpeakableParagraphs } from '../chunker/word-boundary-chunker.js';
import { UniversalEventBus } from '../pipeline/pipeline-event-bus.js';
import { LiveAudioPlayerSink } from '../audio/live-audio-player-sink.js';
import { ChunkQueueAudioPlayer } from '../audio/player/chunk-queue-audio-player.js';
import { NarrationRecorder } from './narration-recorder.js';
import { SessionCatalogService, type TurnItem, type SessionItem } from './session-catalog.js';
import type { ChunkTiming, TrackMetadata } from '../storage/types.js';
import type { VoiceName } from '../types/voice.js';
import type { ITTSProvider } from '../tts/tts-provider.interface.js';
import type { INarrationAdapter } from '../narration/types.js';
import type {
  LiveTurnInput,
  StudioAction,
  StudioState,
  StudioStoreOptions,
} from './types.js';

export function computeActiveChunkIndex(
  chunkTimings?: ChunkTiming[],
  positionMs: number = 0
): number {
  if (!chunkTimings || chunkTimings.length === 0) return -1;
  const match = chunkTimings.findIndex(
    (c) => positionMs >= c.startMs && positionMs <= c.endMs
  );
  if (match !== -1) return match;

  if (positionMs < chunkTimings[0].startMs) return 0;

  for (let i = chunkTimings.length - 1; i >= 0; i--) {
    if (positionMs >= chunkTimings[i].startMs) {
      return i;
    }
  }
  return 0;
}

export class StudioStore implements StudioAction {
  private readonly library: AudioLibrary;
  private readonly player: PlaybackEngine;
  private readonly catalog: SessionCatalogService;
  private readonly ttsProvider?: ITTSProvider;
  private readonly narrationAdapter?: INarrationAdapter;
  private readonly enableLiveAudio: boolean;
  private readonly defaultVoice: VoiceName;
  private readonly defaultStyle?: string;

  private state: StudioState;
  private readonly listeners = new Set<(state: StudioState) => void>();
  private turnQueue: Promise<any> = Promise.resolve();
  private activeRecorder?: NarrationRecorder;
  private livePlayer?: ChunkQueueAudioPlayer;

  constructor(options: StudioStoreOptions = {}) {
    this.library = options.library ?? new AudioLibrary();
    this.player = options.player ?? new PlaybackEngine();
    this.catalog =
      options.catalog ??
      new SessionCatalogService({
        brainDir: options.brainDir,
        library: this.library,
      });
    this.ttsProvider = options.ttsProvider;
    this.narrationAdapter = options.narrationAdapter;
    this.enableLiveAudio = options.enableLiveAudio ?? true;
    this.defaultVoice = options.defaultVoice ?? 'Puck';
    this.defaultStyle = options.defaultStyle;

    const initialTracks = this.library.listTracks();
    const initialSelected = initialTracks[0] ?? null;
    const initialSessions = this.catalog.listSessions({ query: '' });
    const initialSelectedSession = initialSessions[0] ?? null;
    const initialTurns = initialSelectedSession
      ? this.catalog.getSessionTurns(initialSelectedSession.id, {
          query: '',
          audioOnly: false,
        })
      : this.catalog.listSessionTurns({
          query: '',
          audioOnly: false,
        });
    const initialSelectedTurn = initialTurns[0] ?? null;

    this.state = {
      navDepth: 'sessions',
      sessions: initialSessions,
      selectedSession: initialSelectedSession,
      tracks: initialTracks,
      selectedTrack: initialSelected,
      turns: initialTurns,
      selectedTurn: initialSelectedTurn,
      audioOnlyFilter: false,
      viewMode: 'markdown',
      playback: {
        status: 'idle',
        positionMs: 0,
        durationMs: initialSelected ? initialSelected.durationMs : 0,
        rate: 1.0,
        activeChunkIndex: initialSelected ? 0 : -1,
      },
      queue: [],
      live: {
        isStreaming: false,
        activeSessionId: null,
        currentChunkText: null,
      },
      filterQuery: '',
    };

    if (initialSelected) {
      this.player.load(initialSelected, false).catch(() => {});
    }

    this.bindPlayerEvents();
  }

  public getLibrary(): AudioLibrary {
    return this.library;
  }

  public getPlayer(): PlaybackEngine {
    return this.player;
  }

  public subscribe(listener: (state: StudioState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getState(): StudioState {
    return {
      ...this.state,
      playback: { ...this.state.playback },
      live: { ...this.state.live },
      sessions: [...this.state.sessions],
      selectedSession: this.state.selectedSession ? { ...this.state.selectedSession } : null,
      tracks: [...this.state.tracks],
      turns: [...this.state.turns],
      selectedTurn: this.state.selectedTurn ? { ...this.state.selectedTurn } : null,
      queue: [...this.state.queue],
    };
  }

  public async play(trackId?: string): Promise<void> {
    if (trackId) {
      const track = this.library.getTrack(trackId);
      if (track) {
        this.state.selectedTrack = track;
        await this.player.load(track, true);
        return;
      }
    }

    if (this.state.selectedTrack && this.player.currentTrack?.id !== this.state.selectedTrack.id) {
      await this.player.load(this.state.selectedTrack, true);
    } else {
      await this.player.play();
    }
  }

  public pause(): void {
    this.player.pause();
  }

  public togglePause(): void {
    this.player.togglePause();
  }

  public async seek(positionMs: number): Promise<void> {
    await this.player.seek(positionMs);
  }

  public async scrub(deltaMs: number): Promise<void> {
    await this.player.scrub(deltaMs);
  }

  public async setRate(rate: number): Promise<void> {
    await this.player.setRate(rate);
  }

  public async selectTrack(trackId: string): Promise<void> {
    const track = this.library.getTrack(trackId);
    if (!track) return;
    this.state.selectedTrack = track;
    this.state.playback.durationMs = track.durationMs;
    this.state.playback.positionMs = 0;
    this.state.playback.activeChunkIndex = 0;
    await this.player.load(track, false);
    this.emitChange();
  }

  public async selectTurn(id: string): Promise<void> {
    const turn = this.state.turns.find((t) => t.id === id);
    if (!turn) return;
    this.state.selectedTurn = turn;
    if (turn.status === 'cached' && turn.track) {
      this.state.selectedTrack = turn.track;
      this.state.playback.durationMs = turn.track.durationMs;
      this.state.playback.positionMs = 0;
      this.state.playback.activeChunkIndex = 0;
      await this.player.load(turn.track, false);
    } else {
      this.state.selectedTrack = null;
      this.state.playback.durationMs = 0;
      this.state.playback.positionMs = 0;
      this.state.playback.activeChunkIndex = -1;
    }
    this.emitChange();
  }

  public async activateTurn(id: string): Promise<void> {
    const turn = this.state.turns.find((t) => t.id === id);
    if (!turn) return;

    // Cancel any existing live synthesis and stop current playback immediately
    this.abortLiveTurn();
    this.player.stop();
    this.turnQueue = Promise.resolve();

    // Reset any previously synthesizing turns back to ungenerated
    this.state.turns = this.state.turns.map((t) =>
      t.status === 'synthesizing' ? { ...t, status: 'ungenerated' } : t
    );

    this.state.selectedTurn = turn;

    if (turn.status === 'cached' && turn.track) {
      this.state.selectedTrack = turn.track;
      await this.play(turn.track.id);
      return;
    }

    if (turn.status === 'ungenerated' || turn.status === 'synthesizing') {
      this.state.turns = this.state.turns.map((t) =>
        t.id === turn.id ? { ...t, status: 'synthesizing' } : t
      );
      this.state.selectedTurn = { ...turn, status: 'synthesizing' };
      this.emitChange();

      const savedTrack = await this.handleLiveTurn({
        turnId: turn.id,
        sessionId: turn.sessionId,
        stepIndex: turn.stepIndex,
        content: turn.markdown,
      });

      this.state.turns = this.reloadTurns();
      const updatedTurn = this.state.turns.find((t) => t.id === turn.id) ?? null;
      this.state.selectedTurn = updatedTurn;
      if (savedTrack) {
        this.state.selectedTrack = savedTrack;
      }
      this.emitChange();
    }
  }

  private reloadTurns(): TurnItem[] {
    if (this.state.selectedSession) {
      return this.catalog.getSessionTurns(this.state.selectedSession.id, {
        query: this.state.filterQuery,
        audioOnly: this.state.audioOnlyFilter,
      });
    }
    return this.catalog.listSessionTurns({
      query: this.state.filterQuery,
      audioOnly: this.state.audioOnlyFilter,
    });
  }

  public selectSession(sessionId: string): void {
    const session = this.state.sessions.find((s) => s.id === sessionId) ?? null;
    if (session) {
      this.state.selectedSession = session;
      this.state.turns = this.catalog.getSessionTurns(session.id, {
        query: this.state.filterQuery,
        audioOnly: this.state.audioOnlyFilter,
      });
      this.state.selectedTurn = this.state.turns[0] ?? null;
      this.emitChange();
    }
  }

  public drillIntoSession(sessionId?: string): void {
    const targetId = sessionId ?? this.state.selectedSession?.id;
    if (targetId) {
      this.selectSession(targetId);
    }
    this.state.navDepth = 'turns';
    this.emitChange();
  }

  public zoomOutToSessions(): void {
    this.state.navDepth = 'sessions';
    this.state.sessions = this.catalog.listSessions({
      query: this.state.filterQuery,
    });
    if (this.state.selectedSession) {
      const refreshed = this.state.sessions.find((s) => s.id === this.state.selectedSession?.id);
      if (refreshed) {
        this.state.selectedSession = refreshed;
      }
    }
    this.emitChange();
  }

  public toggleAudioOnlyFilter(): void {
    this.state.audioOnlyFilter = !this.state.audioOnlyFilter;
    this.state.turns = this.reloadTurns();
    if (
      !this.state.selectedTurn ||
      !this.state.turns.some((t) => t.id === this.state.selectedTurn?.id)
    ) {
      this.state.selectedTurn = this.state.turns[0] ?? null;
    }
    this.emitChange();
  }

  public toggleViewMode(): void {
    this.state.viewMode = this.state.viewMode === 'markdown' ? 'script' : 'markdown';
    this.emitChange();
  }

  public setFilter(query: string): void {
    this.state.filterQuery = query;
    this.state.tracks = this.library.listTracks({ query });
    this.state.sessions = this.catalog.listSessions({ query });
    this.state.turns = this.reloadTurns();
    if (
      !this.state.selectedTurn ||
      !this.state.turns.some((t) => t.id === this.state.selectedTurn?.id)
    ) {
      this.state.selectedTurn = this.state.turns[0] ?? null;
    }
    if (
      !this.state.selectedSession ||
      !this.state.sessions.some((s) => s.id === this.state.selectedSession?.id)
    ) {
      this.state.selectedSession = this.state.sessions[0] ?? null;
    }
    this.emitChange();
  }

  public async deleteTrack(trackId: string): Promise<void> {
    if (this.player.currentTrack?.id === trackId) {
      this.player.stop();
    }

    await this.library.deleteTrack(trackId);
    this.state.tracks = this.library.listTracks({ query: this.state.filterQuery });
    this.state.sessions = this.catalog.listSessions({ query: this.state.filterQuery });
    this.state.turns = this.reloadTurns();

    if (this.state.selectedTrack?.id === trackId) {
      this.state.selectedTrack = this.state.tracks[0] ?? null;
      if (this.state.selectedTrack) {
        await this.player.load(this.state.selectedTrack, false);
      } else {
        this.player.stop();
      }
    }

    this.emitChange();
  }

  public async next(): Promise<void> {
    await this.player.next();
  }

  public async prev(): Promise<void> {
    await this.player.prev();
  }

  public async handleLiveTurn(input: LiveTurnInput): Promise<TrackMetadata | null> {
    const turnPromise = this.turnQueue.then(() => this.executeLiveTurn(input));
    this.turnQueue = turnPromise.catch(() => {});
    return turnPromise;
  }

  public abortLiveTurn(): void {
    if (this.activeRecorder) {
      this.activeRecorder.abort();
    }
    if (this.livePlayer) {
      this.livePlayer.stop().catch(() => {});
    }
    this.state.live = {
      isStreaming: false,
      activeSessionId: null,
      currentChunkText: null,
    };
    this.emitChange();
  }

  private async executeLiveTurn(input: LiveTurnInput): Promise<TrackMetadata | null> {
    if (!this.ttsProvider) {
      throw new Error('[StudioStore] No TTS provider configured for live turn synthesis.');
    }

    let markdownToSpeak = input.content;
    if (this.narrationAdapter) {
      try {
        markdownToSpeak = await this.narrationAdapter.adaptForNarration(input.content);
      } catch {
        // Fall back gracefully to raw content if adaptation encounters an error
      }
    }

    const paragraphs = parseMarkdownToSpeakableParagraphs(markdownToSpeak);
    const chunks = chunkSpeakableParagraphs(paragraphs, 130);
    if (chunks.length === 0) return null;

    const voice = input.voice || this.defaultVoice;
    const style = input.style ?? this.defaultStyle;

    this.state.live = {
      isStreaming: true,
      activeSessionId: input.sessionId,
      currentChunkText: chunks[0]?.text ?? null,
      completedChunks: 0,
      totalChunks: chunks.length,
    };
    this.emitChange();

    const eventBus = new UniversalEventBus();
    const recorder = new NarrationRecorder(this.ttsProvider, eventBus);
    this.activeRecorder = recorder;

    const BYTES_PER_MS = 48;
    let totalLivePCMBytes = 0;
    let currentChunkStartBytes = 0;
    let currentChunkText = '';
    let currentChunkDeltas: Uint8Array[] = [];
    const liveChunkTimings: ChunkTiming[] = [];

    const initialLiveTrack: TrackMetadata = {
      id: 'live-stream',
      sessionId: input.sessionId,
      slug: 'live-stream',
      stepIndex: input.stepIndex,
      title: input.sessionId,
      durationMs: 0,
      charCount: input.content.length,
      chunkCount: 0,
      createdAt: new Date().toISOString(),
      audioPath: '',
      transcriptPath: '',
      metadataPath: '',
      transcript: input.content,
      chunkTimings: [],
      voice,
    };

    if (this.enableLiveAudio) {
      await this.player.startLiveStream(initialLiveTrack);
    }

    eventBus.on('chunk:start', ({ chunk }) => {
      currentChunkText = chunk.text;
      currentChunkStartBytes = totalLivePCMBytes;
      currentChunkDeltas = [];
      this.state.live.currentChunkText = chunk.text;
      this.emitChange();
    });

    eventBus.on('audio:delta', ({ audioData }) => {
      currentChunkDeltas.push(audioData);
      totalLivePCMBytes += audioData.byteLength;
    });

    eventBus.on('chunk:complete', ({ chunkIndex }) => {
      this.state.live.completedChunks = (this.state.live.completedChunks ?? 0) + 1;
      const startMs = Math.round(currentChunkStartBytes / BYTES_PER_MS);
      const endMs = Math.round(totalLivePCMBytes / BYTES_PER_MS);

      const chunkBytes = currentChunkDeltas.reduce((acc, b) => acc + b.byteLength, 0);
      const chunkPcm = new Uint8Array(chunkBytes);
      let offset = 0;
      for (const delta of currentChunkDeltas) {
        chunkPcm.set(delta, offset);
        offset += delta.byteLength;
      }

      const wordTimings = extractWordTimingsFromPcm(chunkPcm, currentChunkText, startMs);

      const timing: ChunkTiming = {
        chunkIndex,
        startMs,
        endMs,
        text: currentChunkText,
        wordTimings,
      };
      liveChunkTimings.push(timing);

      if (this.enableLiveAudio) {
        this.player.appendLiveChunk(chunkPcm, timing).catch(() => {});
      }

      const currentDurationMs = endMs;
      this.state.selectedTrack = {
        ...initialLiveTrack,
        durationMs: currentDurationMs,
        chunkCount: liveChunkTimings.length,
        chunkTimings: [...liveChunkTimings],
      };
      this.state.playback.durationMs = currentDurationMs;
      this.emitChange();
    });

    try {
      const result = await recorder.record(chunks, voice, style);

      const savedTrack = await this.library.saveTrack({
        id: input.turnId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        markdown: input.content,
        transcript: markdownToSpeak,
        audioBuffer: result.wavBuffer,
        voice,
        style,
        chunkTimings: result.chunkTimings,
      });

      this.state.tracks = this.library.listTracks({ query: this.state.filterQuery });
      this.state.selectedTrack = savedTrack;

      if (this.enableLiveAudio) {
        await this.player.finishLiveStream(savedTrack);
      } else {
        await this.player.load(savedTrack, false);
      }

      return savedTrack;
    } finally {
      this.activeRecorder = undefined;
      this.livePlayer = undefined;
      this.state.live = {
        isStreaming: false,
        activeSessionId: null,
        currentChunkText: null,
        completedChunks: 0,
        totalChunks: 0,
      };
      this.emitChange();
    }
  }

  private bindPlayerEvents(): void {
    this.player.on('status', (status) => {
      this.state.playback.status = status;
      this.emitChange();
    });

    this.player.on('timeupdate', (data) => {
      this.state.playback.positionMs = data.positionMs;
      this.state.playback.durationMs = data.durationMs;
      this.state.playback.rate = data.rate;
      this.state.playback.activeChunkIndex = computeActiveChunkIndex(
        this.state.selectedTrack?.chunkTimings,
        data.positionMs
      );
      this.emitChange();
    });

    this.player.on('track:start', (track) => {
      this.state.selectedTrack = track;
      this.state.playback.durationMs = track.durationMs;
      this.state.playback.positionMs = 0;
      this.state.playback.activeChunkIndex = 0;
      this.state.queue = [...this.player.queue];
      this.emitChange();
    });

    this.player.on('track:end', () => {
      this.state.playback.status = 'stopped';
      this.state.queue = [...this.player.queue];
      this.emitChange();
    });
  }

  private emitChange(): void {
    const currentState = this.getState();
    for (const listener of this.listeners) {
      listener(currentState);
    }
  }
}
