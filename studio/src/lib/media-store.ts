/**
 * Deep Media Storage Module
 *
 * Provides resilient, low-latency offline audio and timings persistence
 * over an Origin Private File System (OPFS) seam, with an in-memory adapter
 * for non-browser/testing environments.
 */

import type { NarrationTimingsFile } from './wav';

export const WAV_HEADER_SIZE = 44;

/**
 * Builds a standard 44-byte RIFF/WAVE header for linear PCM audio.
 */
export function buildWavHeader(
  dataByteLength: number,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE);
  const view = new DataView(buffer);

  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true); // chunkSize = 36 + SubChunk2Size
  writeAscii(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size = 16 for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  return new Uint8Array(buffer);
}

/**
 * Patches the 44-byte WAV header with the final data length in-place.
 */
export function patchWavHeader(header: Uint8Array, dataByteLength: number): Uint8Array {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(4, 36 + dataByteLength, true);
  view.setUint32(40, dataByteLength, true);
  return header;
}

function writeAscii(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Low-level virtual filesystem storage adapter interface at the storage seam.
 */
export interface MediaStorageAdapter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  appendFile(path: string, chunk: Uint8Array): Promise<void>;
  patchFile(path: string, offset: number, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  readSlice(path: string, start: number, end: number): Promise<Uint8Array | null>;
  hasFile(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<void>;
  getUsage(): Promise<{ usedBytes: number; quotaBytes: number }>;
}

/**
 * In-memory adapter for unit testing, SSR, or unsupported environments.
 */
export class MemoryStorageAdapter implements MediaStorageAdapter {
  private files = new Map<string, Uint8Array>();

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(data));
  }

  async appendFile(path: string, chunk: Uint8Array): Promise<void> {
    const existing = this.files.get(path);
    if (!existing) {
      this.files.set(path, new Uint8Array(chunk));
      return;
    }
    const combined = new Uint8Array(existing.byteLength + chunk.byteLength);
    combined.set(existing, 0);
    combined.set(chunk, existing.byteLength);
    this.files.set(path, combined);
  }

  async patchFile(path: string, offset: number, data: Uint8Array): Promise<void> {
    const existing = this.files.get(path);
    if (!existing) {
      throw new Error(`Cannot patch non-existent file: ${path}`);
    }
    if (offset + data.byteLength > existing.byteLength) {
      throw new Error(`Patch out of bounds: file length ${existing.byteLength}, patch ends at ${offset + data.byteLength}`);
    }
    existing.set(data, offset);
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const file = this.files.get(path);
    return file ? new Uint8Array(file) : null;
  }

  async readSlice(path: string, start: number, end: number): Promise<Uint8Array | null> {
    const file = this.files.get(path);
    if (!file) return null;
    return file.slice(start, end);
  }

  async hasFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async getUsage(): Promise<{ usedBytes: number; quotaBytes: number }> {
    let total = 0;
    for (const buf of this.files.values()) {
      total += buf.byteLength;
    }
    return { usedBytes: total, quotaBytes: 1024 * 1024 * 1024 }; // 1GB mock quota
  }
}

/**
 * Origin Private File System (OPFS) adapter for production browser environments.
 */
export class OpfsStorageAdapter implements MediaStorageAdapter {
  private async getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
      throw new Error('OPFS not supported in this environment');
    }
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('mdmedia-audio', { create: true });
  }

  private async getFileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    try {
      const root = await this.getRootDir();
      const parts = path.split('/').filter(Boolean);
      let currentDir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create });
      }
      return await currentDir.getFileHandle(parts[parts.length - 1], { create });
    } catch {
      return null;
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const handle = await this.getFileHandle(path, true);
    if (!handle) throw new Error(`Could not get file handle for ${path}`);
    const writable = await handle.createWritable();
    try {
      await writable.write(data as unknown as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async appendFile(path: string, chunk: Uint8Array): Promise<void> {
    const handle = await this.getFileHandle(path, true);
    if (!handle) throw new Error(`Could not get file handle for ${path}`);
    const file = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(file.size);
      await writable.write(chunk as unknown as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async patchFile(path: string, offset: number, data: Uint8Array): Promise<void> {
    const handle = await this.getFileHandle(path, false);
    if (!handle) throw new Error(`Could not get file handle for ${path}`);
    const writable = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(offset);
      await writable.write(data as unknown as BufferSource);
    } finally {
      await writable.close();
    }
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const handle = await this.getFileHandle(path, false);
    if (!handle) return null;
    const file = await handle.getFile();
    const arrayBuffer = await file.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async readSlice(path: string, start: number, end: number): Promise<Uint8Array | null> {
    const handle = await this.getFileHandle(path, false);
    if (!handle) return null;
    const file = await handle.getFile();
    const slice = file.slice(start, end);
    const arrayBuffer = await slice.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async hasFile(path: string): Promise<boolean> {
    const handle = await this.getFileHandle(path, false);
    return handle !== null;
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const root = await this.getRootDir();
      const parts = path.split('/').filter(Boolean);
      let currentDir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false });
      }
      await currentDir.removeEntry(parts[parts.length - 1]);
    } catch {
      // Ignore if already deleted
    }
  }

  async getUsage(): Promise<{ usedBytes: number; quotaBytes: number }> {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      return {
        usedBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? 0,
      };
    }
    return { usedBytes: 0, quotaBytes: 0 };
  }
}

export interface MediaWriter {
  appendChunk(pcmBytes: Uint8Array): Promise<void>;
  finalize(timings: NarrationTimingsFile): Promise<void>;
  abort(): Promise<void>;
}

export interface MediaStore {
  has(narrationId: string): Promise<boolean>;
  getTrack(narrationId: string): Promise<{ audioBlob: Blob; timings: NarrationTimingsFile } | null>;
  getTimings(narrationId: string): Promise<NarrationTimingsFile | null>;
  openWriter(narrationId: string): Promise<MediaWriter>;
  saveTrack(narrationId: string, audioBlob: Blob, timings: NarrationTimingsFile): Promise<void>;
  delete(narrationId: string): Promise<void>;
  getStorageUsage(): Promise<{ usedBytes: number; quotaBytes: number }>;
}

export class MediaStoreService implements MediaStore {
  constructor(private adapter: MediaStorageAdapter) {}

  private audioPath(id: string): string {
    return `narrations/${id}.wav`;
  }

  private timingsPath(id: string): string {
    return `narrations/${id}.timings.json`;
  }

  async has(narrationId: string): Promise<boolean> {
    const [hasAudio, hasTimings] = await Promise.all([
      this.adapter.hasFile(this.audioPath(narrationId)),
      this.adapter.hasFile(this.timingsPath(narrationId)),
    ]);
    return hasAudio && hasTimings;
  }

  async saveTrack(narrationId: string, audioBlob: Blob, timings: NarrationTimingsFile): Promise<void> {
    const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
    const timingsBytes = new TextEncoder().encode(JSON.stringify(timings, null, 2));
    await Promise.all([
      this.adapter.writeFile(this.audioPath(narrationId), audioBytes),
      this.adapter.writeFile(this.timingsPath(narrationId), timingsBytes),
    ]);
  }

  async getTrack(narrationId: string): Promise<{ audioBlob: Blob; timings: NarrationTimingsFile } | null> {
    const [audioBytes, timingsBytes] = await Promise.all([
      this.adapter.readFile(this.audioPath(narrationId)),
      this.adapter.readFile(this.timingsPath(narrationId)),
    ]);
    if (!audioBytes || !timingsBytes) return null;
    try {
      const timings = JSON.parse(new TextDecoder().decode(timingsBytes)) as NarrationTimingsFile;
      const audioBlob = new Blob([audioBytes as unknown as BlobPart], { type: 'audio/wav' });
      return { audioBlob, timings };
    } catch {
      return null;
    }
  }

  async getTimings(narrationId: string): Promise<NarrationTimingsFile | null> {
    const timingsBytes = await this.adapter.readFile(this.timingsPath(narrationId));
    if (!timingsBytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(timingsBytes)) as NarrationTimingsFile;
    } catch {
      return null;
    }
  }

  async delete(narrationId: string): Promise<void> {
    await Promise.all([
      this.adapter.deleteFile(this.audioPath(narrationId)),
      this.adapter.deleteFile(this.timingsPath(narrationId)),
    ]);
  }

  async getStorageUsage(): Promise<{ usedBytes: number; quotaBytes: number }> {
    return await this.adapter.getUsage();
  }

  async openWriter(narrationId: string): Promise<MediaWriter> {
    // Initialized and fully implemented in Slice 3
    const audioFile = this.audioPath(narrationId);
    const timingsFile = this.timingsPath(narrationId);
    let pcmTotalBytes = 0;

    // Write placeholder 44-byte WAV header at offset 0
    const placeholder = buildWavHeader(0);
    await this.adapter.writeFile(audioFile, placeholder);

    return {
      appendChunk: async (pcmBytes: Uint8Array) => {
        pcmTotalBytes += pcmBytes.byteLength;
        await this.adapter.appendFile(audioFile, pcmBytes);
      },
      finalize: async (timings: NarrationTimingsFile) => {
        const placeholder = await this.adapter.readSlice(audioFile, 0, WAV_HEADER_SIZE);
        if (placeholder) {
          const patched = patchWavHeader(placeholder, pcmTotalBytes);
          await this.adapter.patchFile(audioFile, 0, patched);
        } else {
          const freshHeader = buildWavHeader(pcmTotalBytes, 24000);
          await this.adapter.patchFile(audioFile, 0, freshHeader);
        }
        const timingsBytes = new TextEncoder().encode(JSON.stringify(timings, null, 2));
        await this.adapter.writeFile(timingsFile, timingsBytes);
      },
      abort: async () => {
        await Promise.all([
          this.adapter.deleteFile(audioFile),
          this.adapter.deleteFile(timingsFile),
        ]);
      },
    };
  }
}

let defaultMediaStore: MediaStore | null = null;

export function getMediaStore(customAdapter?: MediaStorageAdapter): MediaStore {
  if (customAdapter) {
    return new MediaStoreService(customAdapter);
  }
  if (!defaultMediaStore) {
    const adapter =
      typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
        ? new OpfsStorageAdapter()
        : new MemoryStorageAdapter();
    defaultMediaStore = new MediaStoreService(adapter);
  }
  return defaultMediaStore;
}

