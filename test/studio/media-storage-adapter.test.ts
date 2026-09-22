import { describe, expect, it } from 'bun:test';
import {
  buildWavHeader,
  patchWavHeader,
  MemoryStorageAdapter,
  type MediaStorageAdapter,
} from '../../studio/src/lib/media-store';

describe('Slice 1: Media Storage Adapter & WAV Header Seam', () => {
  describe('WAV Header Construction & In-Place Patching', () => {
    it('builds a standard 44-byte RIFF/WAVE PCM header for 24kHz 16-bit mono audio', () => {
      const pcmLength = 48000; // 1 second of 24kHz 16-bit mono
      const header = buildWavHeader(pcmLength, 24000, 1, 16);

      expect(header.byteLength).toBe(44);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

      // 'RIFF' chunk descriptor
      expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
      // Total size: 36 + SubChunk2Size
      expect(view.getUint32(4, true)).toBe(36 + pcmLength);
      // 'WAVE'
      expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
      // 'fmt '
      expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))).toBe('fmt ');
      // Subchunk1Size = 16 for PCM
      expect(view.getUint32(16, true)).toBe(16);
      // AudioFormat = 1 (PCM)
      expect(view.getUint16(20, true)).toBe(1);
      // NumChannels = 1
      expect(view.getUint16(22, true)).toBe(1);
      // SampleRate = 24000
      expect(view.getUint32(24, true)).toBe(24000);
      // ByteRate = SampleRate * NumChannels * BitsPerSample/8 = 48000
      expect(view.getUint32(28, true)).toBe(48000);
      // BlockAlign = NumChannels * BitsPerSample/8 = 2
      expect(view.getUint16(32, true)).toBe(2);
      // BitsPerSample = 16
      expect(view.getUint16(34, true)).toBe(16);
      // 'data'
      expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data');
      // SubChunk2Size (data size)
      expect(view.getUint32(40, true)).toBe(pcmLength);
    });

    it('patches an initial placeholder 44-byte WAV header with final byte length', () => {
      const placeholder = buildWavHeader(0, 24000, 1, 16);
      const patched = patchWavHeader(placeholder, 96000); // 2 seconds

      const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
      expect(view.getUint32(4, true)).toBe(36 + 96000);
      expect(view.getUint32(40, true)).toBe(96000);
    });
  });

  describe('MemoryStorageAdapter Implementation', () => {
    it('creates, writes, and reads back binary files', async () => {
      const adapter: MediaStorageAdapter = new MemoryStorageAdapter();

      const sampleData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      await adapter.writeFile('narrations/test.wav', sampleData);

      expect(await adapter.hasFile('narrations/test.wav')).toBe(true);
      const readBack = await adapter.readFile('narrations/test.wav');
      expect(readBack).toEqual(sampleData);
    });

    it('supports incremental append mode', async () => {
      const adapter: MediaStorageAdapter = new MemoryStorageAdapter();

      await adapter.writeFile('stream.pcm', new Uint8Array([1, 2, 3]));
      await adapter.appendFile('stream.pcm', new Uint8Array([4, 5, 6]));

      const full = await adapter.readFile('stream.pcm');
      expect(full).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    });

    it('patches bytes in-place at a specified offset', async () => {
      const adapter: MediaStorageAdapter = new MemoryStorageAdapter();

      const buffer = new Uint8Array([0, 0, 0, 0, 99, 99]);
      await adapter.writeFile('header-test.bin', buffer);

      // Patch the first 4 bytes with [10, 20, 30, 40]
      await adapter.patchFile('header-test.bin', 0, new Uint8Array([10, 20, 30, 40]));

      const result = await adapter.readFile('header-test.bin');
      expect(result).toEqual(new Uint8Array([10, 20, 30, 40, 99, 99]));
    });

    it('reads byte slices without loading entire file', async () => {
      const adapter: MediaStorageAdapter = new MemoryStorageAdapter();

      const data = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      await adapter.writeFile('slicing.bin', data);

      const slice = await adapter.readSlice('slicing.bin', 2, 6);
      expect(slice).toEqual(new Uint8Array([30, 40, 50, 60]));
    });

    it('deletes files and returns false for non-existent files', async () => {
      const adapter: MediaStorageAdapter = new MemoryStorageAdapter();

      await adapter.writeFile('temp.bin', new Uint8Array([1]));
      expect(await adapter.hasFile('temp.bin')).toBe(true);

      await adapter.deleteFile('temp.bin');
      expect(await adapter.hasFile('temp.bin')).toBe(false);
      expect(await adapter.readFile('temp.bin')).toBeNull();
    });
  });
});
