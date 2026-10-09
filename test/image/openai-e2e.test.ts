/**
 * Paid, opt-in CLI smoke test. Exactly one generation and one edit; no retries.
 * OPENAI_IMAGE_E2E=1 bun test test/image/openai-e2e.test.ts
 * Requires OPENAI_API_KEY. Outputs are retained in a unique e2e-output directory.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { imageFormat, pngDimensions } from '../../src/image/image-data.js';

const enabled = process.env.OPENAI_IMAGE_E2E === '1';

describe.skipIf(!enabled)('OpenAI image live CLI smoke test (paid)', () => {
  test('generates a Flare PNG and edits it with Sunburst into a transparent WebP', async () => {
    if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required for the opt-in live test.');
    // Check the inspection dependency before making any paid request.
    await promisify(execFile)('sips', ['--version']);
    const root = path.resolve(import.meta.dir, '../..');
    const base = path.join(import.meta.dir, 'e2e-output');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'openai-'));
    const report: { startedAt: string; outputDirectory: string; status: string; error?: string; cases: object[] } = {
      startedAt: new Date().toISOString(), outputDirectory: directory, status: 'running', cases: [],
    };
    const saveReport = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await saveReport();
    const run = async (name: string, options: string[]) => {
      const started = Date.now();
      const currentCase = { name, status: 'submitting', startedAt: new Date().toISOString() };
      report.cases.push(currentCase);
      await saveReport();
      const child = Bun.spawn([process.execPath, path.join(root, 'src/bin.ts'), 'image', '--provider', 'openai',
        '--quality', 'low', '--size', '1024x1024', '--output', path.join(directory, name),
        '--metadata', path.join(directory, `${name}.json`), ...options], {
        cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exit !== 0) {
        const safeError = stderr.split(process.env.OPENAI_API_KEY!).join('[REDACTED]');
        Object.assign(currentCase, { status: 'failed', durationMs: Date.now() - started, error: safeError });
        throw new Error(`Live CLI test ${name} failed (exit ${exit}): ${safeError}`);
      }
      const metadata = JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
      expect(metadata.provider).toBe('openai');
      expect(metadata.request.quality).toBe('low');
      expect(metadata.request.size).toBe('1024x1024');
      expect(metadata.requestId).toBeTruthy();
      expect(stdout).toContain(metadata.output.path);
      expect(JSON.stringify(metadata).includes(process.env.OPENAI_API_KEY!)).toBe(false);
      Object.assign(currentCase, { status: 'passed', durationMs: Date.now() - started, ...metadata });
      await saveReport();
      return { bytes: await readFile(metadata.output.path), output: metadata.output.path };
    };
    console.log(`[Live image test] Outputs: ${directory}`);
    try {
      const generated = await run('flare.png', ['--model', 'gpt-image-2.5-flare', '--background', 'opaque',
        '--prompt', 'One simple flat teal robot mascot centered on a solid ivory background. Rounded rectangular body, two circular eyes, a small orange antenna. Full character visible, no text, no other objects.']);
      expect(imageFormat(generated.bytes)).toBe('png');
      expect(pngDimensions(generated.bytes)).toEqual({ width: 1024, height: 1024 });
      const edited = await run('sunburst-edit.webp', ['--model', 'gpt-image-2.5-sunburst', '--background', 'transparent',
        '--ref', generated.output,
        '--prompt', 'Edit the supplied robot image. Preserve its teal body, two eyes, silhouette and composition. Change only the small antenna from orange to vivid red. Remove the ivory background completely and deliver a transparent cutout. No text or additional objects.']);
      expect(imageFormat(edited.bytes)).toBe('webp');
      const { stdout } = await promisify(execFile)('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', edited.output]);
      expect(stdout).toContain('pixelWidth: 1024');
      expect(stdout).toContain('pixelHeight: 1024');
      expect(stdout).toContain('hasAlpha: yes');
      report.status = 'passed';
    } catch (error) {
      report.status = 'failed';
      report.error = String(error).split(process.env.OPENAI_API_KEY!).join('[REDACTED]');
      throw error;
    } finally {
      await saveReport();
    }
  }, 660000);
});
