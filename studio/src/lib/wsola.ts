/**
 * WSOLA (Waveform Similarity Overlap-Add) Time-Scale Modification.
 *
 * Decouples playback speed (tempo) from frequency (pitch) for human speech,
 * eliminating the "chipmunk effect" when speeding up or slowing down playback.
 *
 * Algorithm references:
 * - Verhelst & Roelands (1993): "An Overlap-Add Technique Based on Waveform
 *   Similarity (WSOLA) for High Quality Time-Scale Modification of Speech"
 */

const DEFAULT_SAMPLE_RATE = 24000;
// Frame size of 24ms at 24kHz (covers speech pitch periods down to 85Hz)
const DEFAULT_FRAME_SIZE = 576;
const DEFAULT_SEARCH_LAG = 120; // +/- 5ms search range for pitch alignment

/**
 * Precomputes a Hann window of length N with the constant-overlap-add (COLA) property
 * for 50% overlap: w[i] + w[i + N/2] === 1.
 */
function createHannWindow(size: number): Float32Array {
  const win = new Float32Array(size);
  const factor = (2 * Math.PI) / size;
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos(factor * i));
  }
  return win;
}

/**
 * Performs pitch-preserving time-stretching on a Float32Array PCM audio buffer.
 *
 * @param input Raw mono PCM samples.
 * @param rate Target playback rate multiplier (e.g. 1.25, 1.5, 2.0).
 * @param sampleRate Audio sample rate (default: 24000 Hz).
 * @returns Time-stretched PCM buffer with preserved vocal pitch.
 */
export function timeStretchWsola(
  input: Float32Array,
  rate: number,
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): Float32Array {
  if (rate === 1.0 || input.length === 0) {
    return input;
  }

  // Scale frame size and search lag proportionally if sample rate differs
  const frameSize = Math.round((DEFAULT_FRAME_SIZE * sampleRate) / DEFAULT_SAMPLE_RATE);
  const hop = frameSize >> 1; // 50% overlap (Synthesis hop Ss)
  const maxLag = Math.round((DEFAULT_SEARCH_LAG * sampleRate) / DEFAULT_SAMPLE_RATE);
  const window = createHannWindow(frameSize);

  if (input.length < frameSize + maxLag * 2) {
    return input;
  }

  // Estimate output capacity: input.length / rate
  const estimatedOutputLength = Math.ceil(input.length / rate) + frameSize;
  const output = new Float32Array(estimatedOutputLength);

  // Initial output position
  let outPos = 0;
  let inPos = 0;

  // Copy first frame with fade-in window
  for (let i = 0; i < frameSize && i < input.length; i++) {
    output[i] = input[i] * window[i];
  }

  outPos += hop;
  inPos += Math.round(hop * rate);

  let lastInPos = 0;

  while (inPos + frameSize + maxLag < input.length) {
    // Natural continuation from the previous segment:
    const targetPos = lastInPos + hop;
    // Nominal analysis position for this hop:
    const nominalPos = inPos;

    // Search for the lag delta in [-maxLag, maxLag] that maximizes waveform similarity
    let bestDelta = 0;
    let maxCorrelation = -Infinity;

    const minDelta = Math.max(-maxLag, -nominalPos);
    const maxDeltaBound = Math.min(maxLag, input.length - (nominalPos + frameSize) - 1);

    for (let delta = minDelta; delta <= maxDeltaBound; delta += 2) {
      let correlation = 0;
      let energy = 0.0001;

      // Subsampled cross-correlation over the overlap region (hop length)
      const candOffset = nominalPos + delta;
      for (let k = 0; k < hop; k += 2) {
        const c = input[candOffset + k];
        const t = input[targetPos + k];
        correlation += c * t;
        energy += c * c;
      }

      // Normalized similarity metric
      const similarity = correlation / Math.sqrt(energy);
      if (similarity > maxCorrelation) {
        maxCorrelation = similarity;
        bestDelta = delta;
      }
    }

    const bestPos = nominalPos + bestDelta;

    // Overlap-add the selected frame into output using the Hann window
    for (let i = 0; i < frameSize; i++) {
      output[outPos + i] += input[bestPos + i] * window[i];
    }

    lastInPos = bestPos;
    outPos += hop;
    inPos += Math.round(hop * rate);
  }

  return output.subarray(0, outPos);
}

/**
 * Stateful streaming WSOLA time-stretcher for processing audio chunks as they arrive.
 */
export class WsolaTimeStretcher {
  private rate: number;
  private sampleRate: number;
  private carryBuffer: Float32Array = new Float32Array(0);

  constructor(rate: number = 1.0, sampleRate: number = DEFAULT_SAMPLE_RATE) {
    this.rate = rate;
    this.sampleRate = sampleRate;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  getRate(): number {
    return this.rate;
  }

  /**
   * Processes an incoming PCM chunk, returning the pitch-preserved time-stretched samples.
   */
  process(chunk: Float32Array): Float32Array {
    if (this.rate === 1.0) {
      if (this.carryBuffer.length > 0) {
        const merged = new Float32Array(this.carryBuffer.length + chunk.length);
        merged.set(this.carryBuffer, 0);
        merged.set(chunk, this.carryBuffer.length);
        this.carryBuffer = new Float32Array(0);
        return merged;
      }
      return chunk;
    }

    // Combine any leftover samples from previous chunk
    let input = chunk;
    if (this.carryBuffer.length > 0) {
      const merged = new Float32Array(this.carryBuffer.length + chunk.length);
      merged.set(this.carryBuffer, 0);
      merged.set(chunk, this.carryBuffer.length);
      input = merged;
      this.carryBuffer = new Float32Array(0);
    }

    const minSize = DEFAULT_FRAME_SIZE + DEFAULT_SEARCH_LAG * 2;
    if (input.length < minSize) {
      this.carryBuffer = input;
      return new Float32Array(0);
    }

    // Save a small tail margin to carry over to maintain cross-chunk continuity
    const processLength = Math.max(0, input.length - minSize);
    const toProcess = input.subarray(0, processLength + DEFAULT_FRAME_SIZE);
    this.carryBuffer = input.subarray(processLength);

    return timeStretchWsola(toProcess, this.rate, this.sampleRate);
  }

  /**
   * Flushes any remaining carried samples.
   */
  flush(): Float32Array {
    if (this.carryBuffer.length === 0) {
      return new Float32Array(0);
    }
    const remaining = this.carryBuffer;
    this.carryBuffer = new Float32Array(0);
    return timeStretchWsola(remaining, this.rate, this.sampleRate);
  }

  /**
   * Resets internal carry state (e.g. on seek or stop).
   */
  reset(): void {
    this.carryBuffer = new Float32Array(0);
  }
}
