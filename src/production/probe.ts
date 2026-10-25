import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readMp4Duration } from '../video/mp4-duration.js';

/** Reading files for a push: their hash and, for video and WAV, their length, without holding a large take in memory. */

/** SHA-256 of a file's bytes, hex, read as a stream. */
export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * An image's content type from its first bytes (PNG, JPEG, WebP), or null
 * when they are none of those or the file can't be read.
 */
export async function imageTypeOf(file: string): Promise<string | null> {
  let head: Buffer;
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      head = await readAt(handle, 0, 12);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** An MP4's length in seconds, from its `moov` box alone. */
export async function mp4Seconds(file: string): Promise<number | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (let offset = 0; offset + 8 <= size;) {
      const header = await readAt(handle, offset, 16);
      if (header.length < 8) return undefined;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (header.length < 16) return undefined;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8 || offset + boxSize > size) return undefined;
      if (type === 'moov') {
        if (boxSize > 64 * 1024 * 1024) return undefined;
        return readMp4Duration(new Uint8Array(await readAt(handle, offset, boxSize)));
      }
      offset += boxSize;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** A PCM WAV's length in seconds, from its header. A streamed file's placeholder data size is replaced by the file's own. */
export async function wavSeconds(file: string): Promise<number | undefined> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, Math.min(size, 64 * 1024));
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return undefined;
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= head.length;) {
      const id = head.toString('latin1', offset, offset + 4);
      const chunkSize = head.readUInt32LE(offset + 4);
      if (id === 'fmt ' && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16);
      if (id === 'data') {
        if (!byteRate) return undefined;
        const available = size - (offset + 8);
        const data = chunkSize === 0 || chunkSize === 0xffffffff || chunkSize > available ? available : chunkSize;
        return data / byteRate;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** A media file's length in milliseconds, when it can be read cheaply (MP4/MOV and WAV). */
export async function durationMsOf(file: string, mimeType: string): Promise<number | undefined> {
  try {
    const seconds = mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4'
      ? await mp4Seconds(file)
      : mimeType === 'audio/wav' ? await wavSeconds(file) : undefined;
    return seconds === undefined ? undefined : Math.round(seconds * 1000);
  } catch {
    return undefined;
  }
}
