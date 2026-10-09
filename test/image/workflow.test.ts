import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runImageGeneration } from '../../src/image/workflow.js';
import { OpenAIImageProvider } from '../../src/image/openai-image-provider.js';
import { PNG, PNG_BASE64, fakeTransport, json } from './helpers.js';

describe('image workflow and CLI (offline)', () => {
  test('dry run validates configured prompt/ref with no factory or filesystem writes and redacts key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-image-test-'));
    try {
      const referenceImage = join(dir, 'reference.png');
      const input = join(dir, 'prompt.md');
      await writeFile(referenceImage, PNG); await writeFile(input, '  A red fox  ');
      const plan = await runImageGeneration({ input, output: join(dir, 'result.png'), dryRun: true, metadata: join(dir, 'result.json'), apiKey: 'SECRET' }, {
        configured: { provider: 'pixellab', model: 'pixflux', size: '128x64', referenceImage, seed: 0 },
        env: {}, providerFactory: () => { throw new Error('must never construct a provider'); },
      });
      expect(plan).toMatchObject({ dryRun: true, provider: 'pixellab', prompt: 'A red fox', size: '128x64', seed: 0, referenceImage });
      expect(JSON.stringify(plan)).not.toContain('SECRET');
      expect((await readdir(dir)).sort()).toEqual(['prompt.md', 'reference.png']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('missing reference, unsupported combinations and conflicting metadata fail before constructing a provider', async () => {
    let constructed = false;
    const dependencies = { env: {}, providerFactory: () => { constructed = true; throw new Error('unexpected factory'); } };
    await expect(runImageGeneration({ prompt: 'Fox', output: 'fox.png', referenceImage: '/does-not-exist/mdmedia-reference.png', dryRun: true }, dependencies)).rejects.toThrow('ENOENT');
    await expect(runImageGeneration({ prompt: 'Fox', provider: 'pixellab', output: 'fox.jpg' }, dependencies)).rejects.toThrow('PNG');
    await expect(runImageGeneration({ prompt: 'Fox', output: 'fox.jpg', metadata: 'fox.png' }, dependencies)).rejects.toThrow('Metadata path');
    await expect(runImageGeneration({ prompt: 'Fox', output: 'fox.bmp' }, dependencies)).rejects.toThrow('extension');
    expect(constructed).toBe(false);
  });
  test('explicit environment isolation cannot fall back to process credentials in the factory', async () => {
    let resolvedKey: string | undefined;
    await expect(runImageGeneration({ prompt: 'Fox', output: 'fox.png', provider: 'openai' }, {
      env: {}, providerFactory: (options) => { resolvedKey = options.apiKey; throw new Error('fake factory stops before submission'); },
    })).rejects.toThrow('fake factory');
    expect(resolvedKey).toBe('');
  });
  test('writes matching suffix and provenance without key, reference bytes or prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-image-write-'));
    try {
      const metadata = join(dir, 'meta', 'fox.json');
      const plan = await runImageGeneration({ prompt: 'Private prompt', output: join(dir, 'fox.jpg'), metadata, apiKey: 'SECRET' }, {
        env: {}, providerFactory: (selection) => {
          expect(selection.provider).toBe('gemini'); expect(selection.apiKey).toBe('SECRET');
          return { generate: async () => ({ imageBytes: PNG, mimeType: 'image/png', provider: 'gemini', model: 'gemini-3-pro-image', requestId: 'r-123' }) };
        },
      });
      expect(plan.output).toBe(join(dir, 'fox.png'));
      expect(await readFile(plan.output)).toEqual(PNG);
      expect(await readdir(dir)).not.toContain('fox.jpg');
      const saved = await readFile(metadata, 'utf8');
      expect(saved).not.toContain('SECRET'); expect(saved).not.toContain('Private prompt');
      expect(JSON.parse(saved)).toMatchObject({ version: 1, provider: 'gemini', requestId: 'r-123', output: { path: plan.output, mimeType: 'image/png', byteLength: PNG.byteLength } });
      expect(JSON.parse(saved).output.sha256).toHaveLength(64);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('Retro admission receipts survive polling failures and have no credential or image payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-image-receipt-'));
    try {
      const output = join(dir, 'fox.png');
      await expect(runImageGeneration({ prompt: 'Private prompt', output, provider: 'retrodiffusion', apiKey: 'SECRET' }, {
        env: {}, providerFactory: (options) => ({ generate: async () => {
          await options.onSubmitting!({ idempotencyKey: 'unique-key' });
          await options.onSubmitted!({ idempotencyKey: 'unique-key', taskId: 'accepted-job', requestId: 'r' });
          throw new Error('Polling failed');
        } }),
      })).rejects.toThrow('Polling failed');
      const receipt = await readFile(`${output}.job.json`, 'utf8');
      expect(receipt).not.toContain('SECRET'); expect(receipt).not.toContain('Private prompt');
      expect(JSON.parse(receipt)).toMatchObject({ status: 'accepted', taskId: 'accepted-job', idempotencyKey: 'unique-key' });
      expect(JSON.parse(receipt).requestHash).toHaveLength(64);
      expect(await readdir(dir)).toEqual(['fox.png.job.json']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('workflow OpenAI aspect normalization survives adapter validation and posts correct dimensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-openai-workflow-'));
    try {
      const output = join(dir, 'fox.png');
      const plan = await runImageGeneration({ prompt: 'Fox', output, provider: 'openai', apiKey: 'test' }, {
        env: {}, providerFactory: (options) => new OpenAIImageProvider(options.apiKey!, { request: fakeTransport((_url, init) => {
          expect(JSON.parse(String(init.body)).size).toBe('1536x864');
          return json({ data: [{ b64_json: PNG_BASE64 }] });
        }) }),
      });
      expect(plan).toMatchObject({ model: 'gpt-image-2.5-flare', size: '1536x864', aspectRatio: '16:9' });
      expect(await readFile(output)).toEqual(PNG);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('all providers support actual credential-free CLI dry runs, config and smart image routing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mdmedia-image-cli-'));
    try {
      const env = { ...process.env, GEMINI_API_KEY: '', OPENAI_API_KEY: '', RETRODIFFUSION_API_KEY: '', PIXELLAB_API_KEY: '', MDMEDIA_TTS_PROVIDER: 'gemini', MDMEDIA_IMAGE_PROVIDER: '' };
      for (const provider of ['gemini', 'openai', 'retrodiffusion', 'pixellab']) {
        await writeFile(join(dir, '.mdmedia.json'), JSON.stringify({ image: { provider, apiKey: 'CONFIG_SECRET', ...(provider === 'openai' ? { model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'low' } : {}) } }));
        const child = Bun.spawnSync([process.execPath, resolve('src/bin.ts'), '-p', 'Fox', '-o', join(dir, 'fox.png'), '--dry-run'], { cwd: dir, env });
        expect(child.exitCode).toBe(0);
        const text = child.stdout.toString();
        expect(text).not.toContain('CONFIG_SECRET');
        expect(JSON.parse(text)).toMatchObject({ dryRun: true, provider, prompt: 'Fox' });
        if (provider === 'openai') expect(JSON.parse(text)).toMatchObject({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'low' });
      }
      const gemini = Bun.spawnSync([process.execPath, resolve('src/bin.ts'), 'image', '-p', 'Village', '-o', 'village.png', '--provider', 'gemini', '--aspect', '3:2', '--size', '4k', '--dry-run'], { cwd: dir, env });
      expect(gemini.exitCode).toBe(0);
      expect(JSON.parse(gemini.stdout.toString())).toMatchObject({ provider: 'gemini', aspectRatio: '3:2', size: '4K' });
      expect(await readdir(dir)).toEqual(['.mdmedia.json']);
      const bad = Bun.spawnSync([process.execPath, resolve('src/bin.ts'), 'image', '-p', 'Fox', '-o', 'fox.png', '--provider', 'openai', '--model', 'gpt-image-2.5', '--dryRun'], { cwd: dir, env });
      expect(bad.exitCode).not.toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 20000);
});
