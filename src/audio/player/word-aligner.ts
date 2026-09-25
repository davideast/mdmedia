import type { ChunkTiming, WordTiming } from '../../storage/types.js';

export interface WordHighlight {
  wordIndex: number;
  word: string;
  charStart: number;
  charEnd: number;
}

interface WeightedWordToken extends WordHighlight {
  weight: number;
  cumulativeStart: number;
  cumulativeEnd: number;
}

function getWordWeight(word: string): number {
  let weight = 4 + Math.max(1, word.length);
  if (/[.!?]$/.test(word)) {
    weight += 5;
  } else if (/[,;:]$/.test(word)) {
    weight += 3;
  }
  return weight;
}

/**
 * Computes exact word start/end millisecond timestamps directly from a 16-bit 24kHz PCM audio waveform
 * by analyzing the vocal activity envelope across 10ms frames and mapping words proportionally to phonetic weights.
 */
export function extractWordTimingsFromPcm(
  pcmBuffer: Uint8Array,
  text: string,
  chunkStartMs = 0
): WordTiming[] {
  const tokens: Array<{
    wordIndex: number;
    word: string;
    charStart: number;
    charEnd: number;
    weight: number;
    cumulativeStart: number;
    cumulativeEnd: number;
  }> = [];

  // Sanitize bracketed prompt directives (e.g. [style: ...]) by replacing with whitespace to preserve character offsets
  const sanitizedText = text.replace(/\[[^\]]*\]/g, (m) => ' '.repeat(m.length));

  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let totalWeight = 0;
  let index = 0;

  while ((match = regex.exec(sanitizedText)) !== null) {
    const word = match[0];
    if (/^[#>*+-]+$/.test(word)) {
      continue;
    }
    const weight = getWordWeight(word);
    const cumulativeStart = totalWeight;
    totalWeight += weight;
    tokens.push({
      wordIndex: index++,
      word,
      charStart: match.index,
      charEnd: match.index + word.length,
      weight,
      cumulativeStart,
      cumulativeEnd: totalWeight,
    });
  }

  if (tokens.length === 0) return [];

  const BYTES_PER_WINDOW = 480; // 10ms window at 24kHz, 1 channel, 16-bit (48 bytes/ms)
  const WINDOW_MS = 10;
  const numWindows = Math.max(1, Math.floor(pcmBuffer.byteLength / BYTES_PER_WINDOW));
  const rmsValues = new Float32Array(numWindows);
  let maxRms = 0;

  const view = new DataView(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength
  );

  for (let w = 0; w < numWindows; w++) {
    let sumSquares = 0;
    const baseByte = w * BYTES_PER_WINDOW;
    const samplesInWindow = Math.min(
      240,
      Math.floor((pcmBuffer.byteLength - baseByte) / 2)
    );
    for (let s = 0; s < samplesInWindow; s++) {
      const sample = view.getInt16(baseByte + s * 2, true);
      sumSquares += sample * sample;
    }
    const rms = samplesInWindow > 0 ? Math.sqrt(sumSquares / samplesInWindow) : 0;
    rmsValues[w] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Moving average smoothing (5 windows = 50ms) to bridge micro-dips in speech
  const smoothed = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    let sum = 0;
    let count = 0;
    for (let d = -2; d <= 2; d++) {
      if (w + d >= 0 && w + d < numWindows) {
        sum += rmsValues[w + d];
        count++;
      }
    }
    smoothed[w] = sum / count;
  }

  // Silence floor threshold (at least 80, or 6% of peak RMS)
  const silenceThreshold = Math.max(80, maxRms * 0.06);

  // Find true vocal onset and vocal offset across the waveform
  let onsetW = 0;
  while (onsetW < numWindows && rmsValues[onsetW] < silenceThreshold) {
    onsetW++;
  }
  let offsetW = numWindows - 1;
  while (offsetW > onsetW && rmsValues[offsetW] < silenceThreshold) {
    offsetW--;
  }

  // Fallback to uniform progression if buffer is silent or onset reaches offset
  if (onsetW >= offsetW) {
    const chunkDurationMs = numWindows * WINDOW_MS;
    return tokens.map((t) => ({
      wordIndex: t.wordIndex,
      word: t.word,
      startMs: chunkStartMs + Math.round((t.cumulativeStart / totalWeight) * chunkDurationMs),
      endMs: chunkStartMs + Math.round((t.cumulativeEnd / totalWeight) * chunkDurationMs),
      charStart: t.charStart,
      charEnd: t.charEnd,
    }));
  }

  // Activity curve:
  // Voiced windows count as 1.0; silent pause windows count as 0.25 (holds playhead pace during pauses)
  const cumulativeActivity = new Float32Array(numWindows);
  let accumulatedActivity = 0;
  for (let w = onsetW; w <= offsetW; w++) {
    accumulatedActivity += smoothed[w] >= silenceThreshold ? 1.0 : 0.25;
    cumulativeActivity[w] = accumulatedActivity;
  }
  const totalActivity = accumulatedActivity;

  const wordTimings: WordTiming[] = [];
  let prevEndWindow = onsetW;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const startFrac = token.cumulativeStart / totalWeight;
    const endFrac = token.cumulativeEnd / totalWeight;
    const targetStartAct = startFrac * totalActivity;
    const targetEndAct = endFrac * totalActivity;

    let wStart = prevEndWindow;
    if (token.wordIndex === 0) {
      wStart = onsetW;
    } else {
      while (wStart < offsetW && cumulativeActivity[wStart] < targetStartAct) {
        wStart++;
      }
      // Advance past silence if landed in a pause between words
      while (
        wStart < offsetW &&
        smoothed[wStart] < silenceThreshold &&
        cumulativeActivity[wStart] < targetStartAct + 1.0
      ) {
        wStart++;
      }
    }

    let wEnd = wStart;
    while (wEnd < offsetW && cumulativeActivity[wEnd] < targetEndAct) {
      wEnd++;
    }

    // Minimum word duration of 100ms (10 windows) unless compressed near chunk end
    wEnd = Math.max(wStart + 10, wEnd);
    wEnd = Math.min(offsetW + 1, wEnd);
    prevEndWindow = wEnd;

    wordTimings.push({
      wordIndex: token.wordIndex,
      word: token.word,
      startMs: chunkStartMs + wStart * WINDOW_MS,
      endMs: chunkStartMs + wEnd * WINDOW_MS,
      charStart: token.charStart,
      charEnd: token.charEnd,
    });
  }

  return wordTimings;
}

export function getActiveWordAtPosition(
  chunk: ChunkTiming,
  positionMs: number
): WordHighlight | null {
  if (positionMs < chunk.startMs || positionMs > chunk.endMs) {
    return null;
  }

  // 1. Ground-truth lookup using PCM waveform-aligned wordTimings when present
  if (chunk.wordTimings && chunk.wordTimings.length > 0) {
    for (let i = 0; i < chunk.wordTimings.length; i++) {
      const wt = chunk.wordTimings[i];
      if (positionMs >= wt.startMs && positionMs <= wt.endMs) {
        return {
          wordIndex: wt.wordIndex,
          word: wt.word,
          charStart: wt.charStart,
          charEnd: wt.charEnd,
        };
      }
      const nextWt = chunk.wordTimings[i + 1];
      if (nextWt && positionMs > wt.endMs && positionMs < nextWt.startMs) {
        return {
          wordIndex: wt.wordIndex,
          word: wt.word,
          charStart: wt.charStart,
          charEnd: wt.charEnd,
        };
      }
    }

    if (positionMs < chunk.wordTimings[0].startMs) {
      const first = chunk.wordTimings[0];
      return {
        wordIndex: first.wordIndex,
        word: first.word,
        charStart: first.charStart,
        charEnd: first.charEnd,
      };
    }

    const last = chunk.wordTimings[chunk.wordTimings.length - 1];
    return {
      wordIndex: last.wordIndex,
      word: last.word,
      charStart: last.charStart,
      charEnd: last.charEnd,
    };
  }

  // 2. Fallback heuristic when wordTimings are not attached
  const durationMs = chunk.endMs - chunk.startMs;
  if (durationMs <= 0 || !chunk.text.trim()) {
    return null;
  }

  const tokens: WeightedWordToken[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let totalWeight = 0;
  let index = 0;

  while ((match = regex.exec(chunk.text)) !== null) {
    const word = match[0];
    const charStart = match.index;
    const charEnd = charStart + word.length;
    const weight = getWordWeight(word);
    const cumulativeStart = totalWeight;
    totalWeight += weight;
    const cumulativeEnd = totalWeight;

    tokens.push({
      wordIndex: index++,
      word,
      charStart,
      charEnd,
      weight,
      cumulativeStart,
      cumulativeEnd,
    });
  }

  if (tokens.length === 0) return null;

  const leadingSilenceMs = durationMs >= 1500 ? 300 : 0;
  const vocalStartMs = chunk.startMs + leadingSilenceMs;
  const vocalDurationMs = Math.max(100, chunk.endMs - vocalStartMs);

  const elapsedFraction = Math.max(
    0,
    Math.min(1, (positionMs - vocalStartMs) / vocalDurationMs)
  );
  const targetWeight = elapsedFraction * totalWeight;

  for (const token of tokens) {
    if (targetWeight >= token.cumulativeStart && targetWeight <= token.cumulativeEnd) {
      return {
        wordIndex: token.wordIndex,
        word: token.word,
        charStart: token.charStart,
        charEnd: token.charEnd,
      };
    }
  }

  const last = tokens[tokens.length - 1];
  return {
    wordIndex: last.wordIndex,
    word: last.word,
    charStart: last.charStart,
    charEnd: last.charEnd,
  };
}
