/** Read the movie header's duration, without decoding or trusting prompt metadata. */
export function readMp4Duration(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scan = (from: number, until: number): number | undefined => {
    for (let offset = from; offset + 8 <= until;) {
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > until) return undefined;
        size = Number(view.getBigUint64(offset + 8)); header = 16;
      } else if (size === 0) size = until - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > until) return undefined;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      const start = offset + header;
      if (type === 'moov') {
        const result = scan(start, offset + size); if (result !== undefined) return result;
      } else if (type === 'mvhd') {
        const version = bytes[start];
        if (version !== 0 && version !== 1) return undefined;
        const scaleOffset = start + (version === 1 ? 20 : 12);
        if (scaleOffset + (version === 1 ? 12 : 8) > offset + size) return undefined;
        const scale = view.getUint32(scaleOffset);
        const duration = version === 1 ? Number(view.getBigUint64(scaleOffset + 4)) : view.getUint32(scaleOffset + 4);
        const seconds = duration / scale;
        return scale && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
      }
      offset += size;
    }
    return undefined;
  };
  return scan(0, bytes.byteLength);
}
