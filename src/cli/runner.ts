import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { ChunkQueueAudioPlayer, LiveAudioPlayerSink, WavFileStreamSink } from '../audio/index.js';
import {
  NodeFileReader,
  chunkSpeakableParagraphs,
  parseMarkdownToSpeakableParagraphs,
  prepareDocumentChunks,
  prepareStoryboardScenes,
} from '../chunker/index.js';
import { GeminiNarrationAdapter } from '../narration/index.js';
import {
  DocumentAudioPipeline,
  DocumentVideoPipeline,
  UniversalEventBus,
} from '../pipeline/index.js';
import {
  GeminiTTSProvider,
  NodeEnvProvider,
  createGeminiClient,
} from '../tts/index.js';
import type { AspectRatio, DeliveryMode, VideoTask } from '../types/media.js';
import type { VoiceName } from '../types/voice.js';
import {
  GeminiOmniVideoProvider,
  NodeVideoFileWriter,
} from '../video/index.js';
import { ProgressLogger } from './progress-logger.js';

export interface RunAudioSynthesisArgs {
  input: string;
  output: string;
  voice: VoiceName;
  style?: string;
  maxChars?: number;
  model?: string;
  apiKey?: string;
  maxRetries?: number;
  play?: boolean;
  verbose?: boolean;
  narration?: boolean;
  narrationModel?: string;
}

export interface RunNarrationAdaptationArgs {
  input: string;
  output?: string;
  model?: string;
  apiKey?: string;
  verbose?: boolean;
}

export interface RunVideoGenerationArgs {
  input: string;
  output: string;
  model?: string;
  aspectRatio?: AspectRatio;
  task?: VideoTask;
  delivery?: DeliveryMode;
  referenceImages?: string[];
  firstFrame?: string;
  previousInteractionId?: string;
  apiKey?: string;
  maxRetries?: number;
  verbose?: boolean;
}

export async function runNarrationAdaptation(args: RunNarrationAdaptationArgs): Promise<string> {
  const fileReader = new NodeFileReader();
  const rawMarkdown = await fileReader.readText(args.input);

  const apiKey = args.apiKey ?? new NodeEnvProvider().getApiKey();
  const genaiClient = apiKey
    ? new GoogleGenAI({ apiKey })
    : createGeminiClient(new NodeEnvProvider());

  const adapter = new GeminiNarrationAdapter(genaiClient, {
    model: args.model,
  });

  if (args.verbose) {
    console.log(`[Narration] Adapting ${args.input} using ${args.model ?? 'gemini-3.5-flash-lite'}...`);
  }

  const adapted = await adapter.adaptForNarration(rawMarkdown);

  if (args.output) {
    await fs.promises.writeFile(args.output, adapted, 'utf8');
    console.log(`[Success] Narration-optimized script created at: ${args.output}`);
  } else {
    console.log(adapted);
  }

  return adapted;
}

export async function runAudioSynthesis(args: RunAudioSynthesisArgs): Promise<void> {
  const fileReader = new NodeFileReader();
  let rawMarkdown = await fileReader.readText(args.input);

  if (args.narration) {
    const apiKey = args.apiKey ?? new NodeEnvProvider().getApiKey();
    const genaiClient = apiKey
      ? new GoogleGenAI({ apiKey })
      : createGeminiClient(new NodeEnvProvider());
    const adapter = new GeminiNarrationAdapter(genaiClient, {
      model: args.narrationModel,
    });
    if (args.verbose) {
      console.log(`[Narration] Adapting markdown using ${args.narrationModel ?? 'gemini-3.5-flash-lite'}...`);
    }
    rawMarkdown = await adapter.adaptForNarration(rawMarkdown);
  }

  const speakableParagraphs = parseMarkdownToSpeakableParagraphs(rawMarkdown);
  const chunks = chunkSpeakableParagraphs(speakableParagraphs, args.maxChars);

  if (chunks.length === 0) {
    console.warn(`[Warning] No speakable markdown content found in ${args.input}`);
    return;
  }

  const eventBus = new UniversalEventBus();
  const progressLogger = new ProgressLogger(args.verbose);
  progressLogger.attach(eventBus);

  const streamSink = new WavFileStreamSink(args.output);
  streamSink.attachToEventBus(eventBus);
  await streamSink.open();

  let livePlayerSink: LiveAudioPlayerSink | undefined;
  if (args.play) {
    const audioPlayer = new ChunkQueueAudioPlayer();
    livePlayerSink = new LiveAudioPlayerSink(audioPlayer);
    livePlayerSink.attachToEventBus(eventBus);
  }

  const apiKey = args.apiKey ?? new NodeEnvProvider().getApiKey();
  const genaiClient = apiKey
    ? new GoogleGenAI({ apiKey })
    : createGeminiClient(new NodeEnvProvider());

  const ttsProvider = new GeminiTTSProvider(genaiClient, args.maxRetries, args.model);
  const pipeline = new DocumentAudioPipeline(ttsProvider, eventBus);

  await pipeline.processDocument(chunks, args.voice, args.style);

  if (livePlayerSink) {
    console.log('[Live Playback] Waiting for audio playback to finish...');
    await livePlayerSink.waitForPlaybackComplete();
  }

  const bytesWritten = streamSink.getBytesWritten() + 44; // PCM bytes + 44-byte header
  console.log(
    `[Success] Single audio file created at: ${args.output} (${(bytesWritten / 1024).toFixed(1)} KB) in O(1) memory`
  );
}

export async function runVideoGeneration(args: RunVideoGenerationArgs): Promise<void> {
  const fileReader = new NodeFileReader();
  const scenes = await prepareStoryboardScenes(fileReader, args.input);

  if (scenes.length === 0) {
    console.warn(`[Warning] No video storyboard scenes found in ${args.input}`);
    return;
  }

  const eventBus = new UniversalEventBus();
  const progressLogger = new ProgressLogger(args.verbose);
  progressLogger.attach(eventBus);

  const apiKey = args.apiKey ?? new NodeEnvProvider().getApiKey();
  const genaiClient = apiKey
    ? new GoogleGenAI({ apiKey })
    : createGeminiClient(new NodeEnvProvider());

  const videoProvider = new GeminiOmniVideoProvider(genaiClient, args.maxRetries, args.model);
  const pipeline = new DocumentVideoPipeline(videoProvider, eventBus);

  const results = await pipeline.processScenes(scenes, {
    model: args.model,
    aspectRatio: args.aspectRatio,
    task: args.task,
    delivery: args.delivery,
    referenceImages: args.referenceImages,
    firstFrame: args.firstFrame,
    previousInteractionId: args.previousInteractionId,
  });

  if (results.length > 0) {
    const fileWriter = new NodeVideoFileWriter();
    // For single-scene or primary video generation, write output directly
    await fileWriter.writeVideoFile(args.output, results[0].videoBytes);
    console.log(
      `[Success] Video clip created at: ${args.output} (${(results[0].videoBytes.byteLength / 1024).toFixed(1)} KB)`
    );
  }
}

export interface RunMusicGenerationArgs {
  prompt?: string;
  input?: string;
  output: string;
  model?: string;
  outputFormat?: 'mp3' | 'wav';
  referenceImages?: string[];
  apiKey?: string;
  maxRetries?: number;
  verbose?: boolean;
}

export async function runMusicGeneration(args: RunMusicGenerationArgs): Promise<void> {
  let prompt = args.prompt || '';
  if (!prompt && args.input) {
    const fileReader = new NodeFileReader();
    prompt = await fileReader.readText(args.input);
  }
  if (!prompt) {
    throw new Error('Either --prompt (-p) or --input (-i) must be provided.');
  }

  const eventBus = new UniversalEventBus();
  const progressLogger = new ProgressLogger(args.verbose);
  progressLogger.attach(eventBus);

  const apiKey = args.apiKey ?? new NodeEnvProvider().getApiKey();
  const genaiClient = apiKey
    ? new GoogleGenAI({ apiKey })
    : createGeminiClient(new NodeEnvProvider());

  const { LyriaMusicProvider } = await import('../music/lyria-music-provider.js');
  const { DocumentMusicPipeline } = await import('../pipeline/document-music-pipeline.js');
  const { NodeMusicFileWriter } = await import('../music/music-file-writer.js');

  const musicProvider = new LyriaMusicProvider(genaiClient, args.maxRetries, args.model);
  const pipeline = new DocumentMusicPipeline(musicProvider, eventBus);

  const result = await pipeline.generate(prompt, {
    model: args.model,
    outputFormat: args.outputFormat,
    referenceImages: args.referenceImages,
  });

  const fileWriter = new NodeMusicFileWriter();
  await fileWriter.writeMusicFile(args.output, result.audioBytes);

  const sizeKb = (result.audioBytes.byteLength / 1024).toFixed(1);
  console.log(`[Success] Music file created at: ${args.output} (${sizeKb} KB)`);
  if (result.lyrics) {
    console.log(`\n[Lyrics]\n${result.lyrics}`);
  }
}

