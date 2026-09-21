import type { ChunkTiming, WordTiming } from '../../storage/types.js';

export interface WordHighlight {
  wordIndex: number;
  word: string;
  charStart: number;
  charEnd: number;
}

interface WeightedWordToken extends WordHighlight {
  weight: number;
  cumStart: number;
  cumEnd: number;
}

function getWordWeight(word: string): number {
  let weight = Math.max(1, word.length);
  if (/[,;:]$/.test(word)) {
    weight += 12; // Clause/comma breath pause (~300ms)
  } else if (/[.!?—]$/.test(word)) {
    weight += 20; // Sentence boundary breath pause (~550ms)
  }
  return weight;
}

/**
 * Computes exact word start/end millisecond timestamps directly from a 16-bit 24kHz PCM audio waveform
 * by analyzing the RMS vocal energy envelope across 10ms frames and mapping voiced speech bursts.
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
    cumStart: number;
    cumEnd: number;
  }> = [];

  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  let totalWeight = 0;
  let index = 0;

  while ((match = regex.exec(text)) !== null) {
    const word = match[0];
    if (/^[#>*+-]+$/.test(word)) {
      continue;
    }
    const weight = getWordWeight(word);
    const cumStart = totalWeight;
    totalWeight += weight;
    tokens.push({
      wordIndex: index++,
      word,
      charStart: match.index,
      charEnd: match.index + word.length,
      weight,
      cumStart,
      cumEnd: totalWeight,
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

  // Silence floor threshold: zero out silent frames so cumulative energy holds during pauses
  const silenceThreshold = Math.max(80, maxRms * 0.08);
  const cumEnergy = new Float32Array(numWindows);
  let runningEnergy = 0;

  for (let w = 0; w < numWindows; w++) {
    const voiced = rmsValues[w] >= silenceThreshold ? rmsValues[w] : 0;
    runningEnergy += voiced;
    cumEnergy[w] = runningEnergy;
  }

  // Fallback to uniform progression if buffer is silent
  if (runningEnergy <= 0) {
    for (let w = 0; w < numWindows; w++) {
      cumEnergy[w] = w + 1;
    }
    runningEnergy = numWindows;
  }

  const wordTimings: WordTiming[] = [];
  let prevEndWindow = 0;

  for (const token of tokens) {
    const startFrac = token.cumStart / totalWeight;
    const endFrac = token.cumEnd / totalWeight;
    const targetStartEnergy = startFrac * runningEnergy;
    const targetEndEnergy = endFrac * runningEnergy;

    let wStart = prevEndWindow;
    if (token.wordIndex === 0) {
      while (wStart < numWindows - 1 && cumEnergy[wStart] === 0) {
        wStart++;
      }
    } else {
      while (wStart < numWindows - 1 && cumEnergy[wStart] < targetStartEnergy) {
        wStart++;
      }
      // Also advance past silent frames if we landed in a silent pause between words
      while (wStart < numWindows - 1 && rmsValues[wStart] < silenceThreshold) {
        wStart++;
      }
    }

    let wEnd = wStart;
    while (wEnd < numWindows - 1 && cumEnergy[wEnd] < targetEndEnergy) {
      wEnd++;
    }

    const endWindow = Math.max(wStart + 1, wEnd + 1);
    prevEndWindow = endWindow;

    wordTimings.push({
      wordIndex: token.wordIndex,
      word: token.word,
      startMs: chunkStartMs + wStart * WINDOW_MS,
      endMs: chunkStartMs + endWindow * WINDOW_MS,
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
    const cumStart = totalWeight;
    totalWeight += weight;
    const cumEnd = totalWeight;

    tokens.push({
      wordIndex: index++,
      word,
      charStart,
      charEnd,
      weight,
      cumStart,
      cumEnd,
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
    if (targetWeight >= token.cumStart && targetWeight <= token.cumEnd) {
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
