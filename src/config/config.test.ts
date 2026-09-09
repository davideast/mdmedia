import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfigFile } from './config-loader.js';
import { resolveConfig } from './config-resolver.js';
import type { MdMediaConfig } from './file-config.js';

const TEST_DIR = resolve(process.cwd(), 'test_scratch_config');

describe('Configuration Loader & Resolver (.mdmedia.json)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('loads .mdmedia.json configuration file successfully', async () => {
    const configPath = resolve(TEST_DIR, '.mdmedia.json');
    const mockConfig: MdMediaConfig = {
      mode: 'video',
      audio: {
        voice: 'Zephyr',
        play: true,
      },
      video: {
        model: 'gemini-omni-flash-preview',
        aspectRatio: '9:16',
        task: 'image_to_video',
        delivery: 'uri',
      },
      maxChars: 500,
      maxRetries: 4,
    };
    await writeFile(configPath, JSON.stringify(mockConfig, null, 2));

    const loaded = await loadConfigFile(TEST_DIR);
    expect(loaded).toEqual(mockConfig);
  });

  it('returns empty object when .mdmedia.json is missing', async () => {
    const loaded = await loadConfigFile(TEST_DIR);
    expect(loaded).toEqual({});
  });

  it('resolves audio configuration with correct precedence (CLI > File > Env > Defaults)', () => {
    const fileConfig: MdMediaConfig = {
      mode: 'audio',
      audio: {
        voice: 'Charon',
        model: 'custom-tts-model',
        style: 'whisper style',
      },
      maxChars: 350,
      maxRetries: 5,
    };

    const resolved = resolveConfig(
      {
        voice: 'Puck',
        play: true,
      },
      fileConfig,
      { GEMINI_API_KEY: 'test-env-key' }
    );

    expect(resolved.mode).toBe('audio');
    expect(resolved.audio.voice).toBe('Puck'); // CLI override
    expect(resolved.audio.model).toBe('custom-tts-model'); // File override
    expect(resolved.audio.style).toBe('whisper style');
    expect(resolved.audio.play).toBe(true); // CLI override
    expect(resolved.apiKey).toBe('test-env-key'); // Env
    expect(resolved.maxChars).toBe(350); // File
    expect(resolved.maxRetries).toBe(5); // File
  });

  it('resolves video configuration with correct precedence and defaults', () => {
    const fileConfig: MdMediaConfig = {
      mode: 'video',
      video: {
        aspectRatio: '16:9',
        task: 'text_to_video',
      },
    };

    const resolved = resolveConfig(
      {
        aspectRatio: '9:16',
        task: 'reference_to_video',
        referenceImages: ['ref1.png'],
      },
      fileConfig,
      {}
    );

    expect(resolved.video.aspectRatio).toBe('9:16'); // CLI override
    expect(resolved.video.task).toBe('reference_to_video'); // CLI override
    expect(resolved.video.model).toBe('gemini-omni-flash-preview'); // Default
    expect(resolved.video.delivery).toBe('uri'); // Default
    expect(resolved.video.referenceImages).toEqual(['ref1.png']);
  });

  it('resolves narration configuration with correct precedence (CLI > File > Defaults)', () => {
    // 1. Defaults when unspecified
    const defaultResolved = resolveConfig({}, {});
    expect(defaultResolved.narration.enabled).toBe(false);
    expect(defaultResolved.narration.model).toBe('gemini-3.5-flash-lite');

    // 2. File config overrides defaults
    const fileResolved = resolveConfig(
      {},
      {
        narration: {
          enabled: true,
          model: 'gemini-file-model',
        },
      }
    );
    expect(fileResolved.narration.enabled).toBe(true);
    expect(fileResolved.narration.model).toBe('gemini-file-model');

    // 3. CLI overrides file config
    const cliResolved = resolveConfig(
      {
        narration: false,
        narrationModel: 'gemini-cli-model',
      },
      {
        narration: {
          enabled: true,
          model: 'gemini-file-model',
        },
      }
    );
    expect(cliResolved.narration.enabled).toBe(false);
    expect(cliResolved.narration.model).toBe('gemini-cli-model');
  });
});

