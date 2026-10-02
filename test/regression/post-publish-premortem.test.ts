import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cliCommands from '../../src/cli/command.js';
import { installAntigravityPlugin } from '../../src/cli/plugin-installer.js';

describe('Post-Publish Pre-Mortem Regressions', () => {
  it('cuts TUI, studio, sidecar, and watch/studio/plugin commands from the published CLI/SDK release', () => {
    const pkgJson = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../package.json'), 'utf8')
    );

    expect(pkgJson.dependencies).not.toHaveProperty('@opentui/core');
    expect(pkgJson.dependencies).not.toHaveProperty('@opentui/react');
    expect(pkgJson.dependencies).not.toHaveProperty('react');
    expect(pkgJson.exports).not.toHaveProperty('./tui');
    expect(pkgJson.exports).not.toHaveProperty('./studio');

    const rootIndexContent = fs.readFileSync(
      path.resolve(import.meta.dir, '../../src/index.ts'),
      'utf8'
    );
    expect(rootIndexContent).not.toContain('./tui/index.js');
    expect(rootIndexContent).not.toContain('./studio/index.js');
    expect(rootIndexContent).not.toContain('./sidecar/narrator-server.js');
    expect(rootIndexContent).not.toContain('./cli/listen-parser.js');

    const subCommands = cliCommands.mainCommand.subCommands as Record<string, unknown>;
    expect(subCommands).not.toHaveProperty('watch');
    expect(subCommands).not.toHaveProperty('studio');
    expect(subCommands).not.toHaveProperty('plugin');
  });

  it('routes top-level -i/-o invocations by output extension and supports --aspect on videoCommand per README', () => {
    const resolveSmartCliArgv = (cliCommands as Record<string, any>).resolveSmartCliArgv as
      | ((argv: string[]) => string[])
      | undefined;

    expect(typeof resolveSmartCliArgv).toBe('function');
    expect(resolveSmartCliArgv!(['-i', 'doc.md', '-o', 'out.wav'])).toEqual([
      'audio',
      '-i',
      'doc.md',
      '-o',
      'out.wav',
    ]);
    expect(resolveSmartCliArgv!(['-i', 'storyboard.md', '-o', 'scene.mp4'])).toEqual([
      'video',
      '-i',
      'storyboard.md',
      '-o',
      'scene.mp4',
    ]);
    expect(resolveSmartCliArgv!(['-i', 'song.md', '-o', 'track.mp3'])).toEqual([
      'music',
      '-i',
      'song.md',
      '-o',
      'track.mp3',
    ]);
    expect(resolveSmartCliArgv!(['audio', '-i', 'doc.md'])).toEqual([
      'audio',
      '-i',
      'doc.md',
    ]);

    const videoArgs = cliCommands.videoCommand.args as Record<string, any>;
    const aspectAliases = Array.isArray(videoArgs.aspectRatio?.alias)
      ? videoArgs.aspectRatio.alias
      : [videoArgs.aspectRatio?.alias];
    expect(aspectAliases.includes('aspect') || Boolean(videoArgs.aspect)).toBe(true);
  });

  it('emits sidecars/narrator/main.mjs and assets/logo.svg in installAntigravityPlugin', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-plugin-test-'));
    try {
      const pluginDir = (installAntigravityPlugin as (baseDir?: string) => string)(tmpHome);
      expect(pluginDir.startsWith(tmpHome)).toBe(true);

      const sidecarJson = JSON.parse(
        fs.readFileSync(path.join(pluginDir, 'sidecars/narrator/sidecar.json'), 'utf8')
      );
      const entryScript = sidecarJson.args[0];
      const entryScriptPath = path.join(pluginDir, 'sidecars/narrator', entryScript);
      expect(fs.existsSync(entryScriptPath)).toBe(true);

      const pluginJson = JSON.parse(
        fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8')
      );
      const logoPath = path.join(pluginDir, pluginJson.logo);
      expect(fs.existsSync(logoPath)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('writes numbered scene files when a video storyboard produces multiple scenes', async () => {
    const runnerMod = (await import('../../src/cli/runner.js')) as Record<string, any>;
    const writeVideoSceneOutputs = runnerMod.writeVideoSceneOutputs as
      | ((
          outputPath: string,
          results: Array<{ sceneIndex: number; videoBytes: Uint8Array; interactionId: string }>
        ) => Promise<string[]>)
      | undefined;

    expect(typeof writeVideoSceneOutputs).toBe('function');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-video-scenes-'));
    try {
      const outPath = path.join(tmpDir, 'scene.mp4');
      const writtenPaths = await writeVideoSceneOutputs!(outPath, [
        { sceneIndex: 0, videoBytes: new Uint8Array([1, 2, 3]), interactionId: 'id_1' },
        { sceneIndex: 1, videoBytes: new Uint8Array([4, 5, 6, 7]), interactionId: 'id_2' },
      ]);

      expect(writtenPaths).toEqual([
        path.join(tmpDir, 'scene.mp4'),
        path.join(tmpDir, 'scene-2.mp4'),
      ]);
      expect(Array.from(fs.readFileSync(path.join(tmpDir, 'scene.mp4')))).toEqual([1, 2, 3]);
      expect(Array.from(fs.readFileSync(path.join(tmpDir, 'scene-2.mp4')))).toEqual([4, 5, 6, 7]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
