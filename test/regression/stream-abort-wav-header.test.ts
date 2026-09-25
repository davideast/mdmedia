import { describe, expect, it } from 'bun:test';
import { WavFileStreamSink } from '../../src/audio/wav-file-stream-sink.js';
import { UniversalEventBus } from '../../src/pipeline/pipeline-event-bus.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Insight 9f6988ab: Midstream aborts corrupt WAV headers and drop timing', () => {
  it('finalizes WAV header on pipeline:error when audio bytes have been written', async () => {
    const tmpFile = path.join(os.tmpdir(), `abort-oracle-${Date.now()}.wav`);
    const sink = new WavFileStreamSink(tmpFile);
    const bus = new UniversalEventBus();
    sink.attachToEventBus(bus);

    await sink.writePCMChunk(new Uint8Array(120));
    await bus.emitAndWait('pipeline:error', { error: new Error('Stream aborted') });
    await new Promise((r) => setTimeout(r, 60));

    expect(fs.existsSync(tmpFile)).toBe(true);
    const fileBytes = fs.readFileSync(tmpFile);
    try {
      fs.unlinkSync(tmpFile);
    } catch {}

    const isRiff = fileBytes.subarray(0, 4).toString('ascii') === 'RIFF';
    const isWave = fileBytes.subarray(8, 12).toString('ascii') === 'WAVE';
    expect(isRiff).toBe(true);
    expect(isWave).toBe(true);
  });
});
