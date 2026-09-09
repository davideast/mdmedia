import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateTrackSlug } from './slugifier.js';
import type {
  CatalogIndex,
  SaveTrackInput,
  TrackFilter,
  TrackMetadata,
} from './types.js';

export function getDefaultAudioLibraryDir(): string {
  if (process.env.ANTIGRAVITY_AUDIO_DIR) {
    return process.env.ANTIGRAVITY_AUDIO_DIR;
  }
  return path.join(os.homedir(), '.gemini/antigravity/audio_library');
}

export class AudioLibrary extends EventEmitter {
  private readonly baseDir: string;
  private readonly catalogPath: string;
  private readonly tracksDir: string;
  private catalog: CatalogIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tracks: [],
  };

  constructor(baseDir?: string) {
    super();
    this.baseDir = baseDir ?? getDefaultAudioLibraryDir();
    this.tracksDir = path.join(this.baseDir, 'tracks');
    this.catalogPath = path.join(this.baseDir, 'catalog.json');
    this.init();
  }

  public init(): void {
    if (!fs.existsSync(this.tracksDir)) {
      fs.mkdirSync(this.tracksDir, { recursive: true });
    }

    if (fs.existsSync(this.catalogPath)) {
      try {
        const raw = fs.readFileSync(this.catalogPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.tracks)) {
          this.catalog = parsed;
          return;
        }
      } catch (err) {
        console.warn('[AudioLibrary] Corrupt catalog.json encountered, rebuilding index:', err);
      }
    }

    this.saveCatalog();
  }

  public async saveTrack(input: SaveTrackInput): Promise<TrackMetadata> {
    const fallbackId = `${input.sessionId.slice(0, 8)}_s${input.stepIndex}`;
    const { title, slug } = generateTrackSlug(input.markdown, fallbackId);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const folderName = `${input.sessionId.slice(0, 8)}_s${input.stepIndex}_${slug}`;
    const trackDir = path.join(this.tracksDir, dateStr, folderName);

    if (!fs.existsSync(trackDir)) {
      fs.mkdirSync(trackDir, { recursive: true });
    }

    const audioPath = path.join(trackDir, 'audio.wav');
    const transcriptPath = path.join(trackDir, 'transcript.md');
    const metadataPath = path.join(trackDir, 'metadata.json');

    // Calculate duration from PCM bytes (44-byte WAV header, 24kHz 16-bit mono = 48 bytes/ms)
    const pcmBytes = Math.max(0, input.audioBuffer.byteLength - 44);
    const durationMs = Math.round(pcmBytes / 48);

    const track: TrackMetadata = {
      id: input.id ?? `${input.sessionId.slice(0, 8)}_s${input.stepIndex}`,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      title,
      slug,
      voice: input.voice,
      style: input.style,
      durationMs,
      charCount: input.markdown.length,
      chunkCount: input.chunkTimings?.length ?? 1,
      createdAt: now.toISOString(),
      audioPath,
      transcriptPath,
      metadataPath,
      chunkTimings: input.chunkTimings,
      transcript: input.markdown,
    };

    // Write all artifacts
    fs.writeFileSync(audioPath, input.audioBuffer);
    fs.writeFileSync(transcriptPath, input.markdown, 'utf8');
    fs.writeFileSync(metadataPath, JSON.stringify(track, null, 2), 'utf8');

    // Update in-memory catalog (replace existing if same ID, or prepend)
    const existingIdx = this.catalog.tracks.findIndex((t) => t.id === track.id);
    if (existingIdx !== -1) {
      this.catalog.tracks[existingIdx] = track;
    } else {
      this.catalog.tracks.unshift(track);
    }

    this.saveCatalog();
    this.emit('track:saved', track);

    return track;
  }

  private hydrateTranscript(track: TrackMetadata): TrackMetadata {
    if (!track.transcript && track.transcriptPath && fs.existsSync(track.transcriptPath)) {
      try {
        track.transcript = fs.readFileSync(track.transcriptPath, 'utf8');
      } catch {}
    }
    return track;
  }

  public listTracks(filter?: TrackFilter): TrackMetadata[] {
    let result = this.catalog.tracks.map((t) => this.hydrateTranscript(t));

    if (filter?.sessionId) {
      result = result.filter((t) => t.sessionId === filter.sessionId);
    }

    if (filter?.query && filter.query.trim()) {
      const q = filter.query.toLowerCase().trim();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          t.sessionId.toLowerCase().includes(q) ||
          Boolean(t.transcript && t.transcript.toLowerCase().includes(q))
      );
    }

    // Sort newest first
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return result;
  }

  public getTrack(id: string): TrackMetadata | null {
    const found = this.catalog.tracks.find((t) => t.id === id);
    return found ? this.hydrateTranscript(found) : null;
  }

  public async deleteTrack(id: string): Promise<boolean> {
    const trackIndex = this.catalog.tracks.findIndex((t) => t.id === id);
    if (trackIndex === -1) return false;

    const track = this.catalog.tracks[trackIndex];
    const trackDir = path.dirname(track.audioPath);

    if (fs.existsSync(trackDir)) {
      fs.rmSync(trackDir, { recursive: true, force: true });
    }

    this.catalog.tracks.splice(trackIndex, 1);
    this.saveCatalog();
    this.emit('track:deleted', id);
    return true;
  }

  private saveCatalog(): void {
    this.catalog.updatedAt = new Date().toISOString();
    const tempFile = path.join(
      this.baseDir,
      `catalog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.tmp`
    );

    fs.writeFileSync(tempFile, JSON.stringify(this.catalog, null, 2), 'utf8');
    fs.renameSync(tempFile, this.catalogPath);
    this.emit('catalog:reloaded', this.catalog);
  }
}
