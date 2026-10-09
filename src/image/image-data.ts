import type { ImageFormat } from './types.js';

export function imageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
      Buffer.from(bytes.subarray(12, 16)).toString() === 'IHDR') return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'webp';
  throw new Error('Provider returned unsupported or invalid image bytes (expected PNG, JPEG or WebP).');
}

export function decodeImage(data: string): Uint8Array {
  const encoded = data.replace(/^data:image\/[^;]+;base64,/, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Provider returned invalid base64 image data.');
  const bytes = Buffer.from(encoded, 'base64');
  imageFormat(bytes);
  return bytes;
}

export function imageMimeType(bytes: Uint8Array): string {
  return `image/${imageFormat(bytes)}`;
}

export function isOpaqueRgbPng(bytes: Uint8Array): boolean {
  if (imageFormat(bytes) !== 'png' || bytes[25] !== 2) return false;
  const buffer = Buffer.from(bytes);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') return false;
    if (type === 'IEND') return true;
    offset = end;
  }
  return false;
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (imageFormat(bytes) !== 'png') return undefined;
  const buffer = Buffer.from(bytes);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
