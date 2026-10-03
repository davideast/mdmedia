import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';

const SANDBOX_DIR = join(os.tmpdir(), 'mdmedia-consumer-sandbox');

async function verifyPackagingAndConsumerHarness() {
  console.log('=== Running mdmedia Packaging & Consumer Sandbox Verification ===');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, message: string) {
    total++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${message}`);
    }
  }

  const pkgJson = JSON.parse(
    await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
  ) as {
    version: string;
    bin: Record<string, string>;
    exports: Record<string, { types: string; import: string }>;
  };

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.npm_config_dry_run;

  // 1. Build production bundle
  console.log('\n--- 1. Building Production Package (dist/) ---');
  execSync('bun run build', { stdio: 'inherit', env: childEnv });
  assert(fs.existsSync(resolve(process.cwd(), 'dist', 'bin.js')), 'dist/bin.js emitted');
  assert(fs.existsSync(resolve(process.cwd(), 'dist', 'index.d.ts')), 'dist/index.d.ts emitted');

  // 2. Pack npm tarball & verify manifest hygiene
  console.log('\n--- 2. Generating npm Package Tarball & Auditing Manifest (npm pack) ---');
  const dryRunJson = JSON.parse(
    execSync('npm pack --dry-run --json', { encoding: 'utf-8', env: childEnv })
  ) as Array<{ files: Array<{ path: string }> }>;
  const packedPaths = new Set(dryRunJson[0]?.files.map((f) => f.path) ?? []);

  assert(
    packedPaths.has('LICENSE') && packedPaths.has('README.md') && packedPaths.has('package.json'),
    'Tarball includes LICENSE, README.md, and package.json'
  );
  assert(
    !packedPaths.has('dist/verify-package.js') &&
      !packedPaths.has('dist/verify-port.js') &&
      !packedPaths.has('dist/cli/agy-watch.js') &&
      !packedPaths.has('dist/cli/plugin-installer.js') &&
      !packedPaths.has('dist/cli/listen-parser.js') &&
      ![...packedPaths].some(
        (p) =>
          p.startsWith('dist/tui/') ||
          p.startsWith('dist/studio/') ||
          p.startsWith('dist/sidecar/') ||
          p.includes('.test.')
      ),
    'Tarball excludes dev verification scripts, TUI, studio, sidecar, watch/plugin scripts, and test files'
  );

  const missingExports: string[] = [];
  for (const [subpath, targets] of Object.entries(pkgJson.exports)) {
    const importPath = targets.import.replace(/^\.\//, '');
    const typesPath = targets.types.replace(/^\.\//, '');
    if (!packedPaths.has(importPath)) missingExports.push(`${subpath} -> ${importPath}`);
    if (!packedPaths.has(typesPath)) missingExports.push(`${subpath} -> ${typesPath}`);
  }
  assert(
    missingExports.length === 0,
    `All ${Object.keys(pkgJson.exports).length} package.json export targets exist in tarball`
  );

  // 3. Prepare Consumer Sandbox & Pack Tarball into Sandbox
  console.log('\n--- 3. Creating Consumer Sandbox & Installing Package ---');
  if (fs.existsSync(SANDBOX_DIR)) {
    await rm(SANDBOX_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  const packOutput = execSync(
    `npm pack --quiet --pack-destination "${SANDBOX_DIR}"`,
    { encoding: 'utf-8', env: childEnv }
  ).trim();
  const tarballPath = resolve(SANDBOX_DIR, packOutput);
  assert(fs.existsSync(tarballPath), `Tarball created: ${packOutput}`);

  const consumerPackageJson = {
    name: 'mdmedia-consumer-test',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      mdmedia: `file:${tarballPath}`,
    },
  };
  await writeFile(
    resolve(SANDBOX_DIR, 'package.json'),
    JSON.stringify(consumerPackageJson, null, 2)
  );

  execSync('npm install --no-package-lock --silent', { cwd: SANDBOX_DIR, env: childEnv });
  assert(
    fs.existsSync(resolve(SANDBOX_DIR, 'node_modules', 'mdmedia')),
    'mdmedia installed into consumer node_modules'
  );
  assert(
    fs.existsSync(resolve(SANDBOX_DIR, 'node_modules', '.bin', 'mdmedia')),
    'mdmedia CLI binary installed into node_modules/.bin'
  );

  // 4. Test Pure Node CLI Executable (shebang, --version, --help, subcommand --help)
  console.log('\n--- 4. Testing CLI Executable in Pure Standard Node.js ---');
  const cliHelpOutput = execSync(
    'node ./node_modules/.bin/mdmedia --help',
    { cwd: SANDBOX_DIR, encoding: 'utf-8', env: childEnv }
  );
  assert(
    cliHelpOutput.includes('mdmedia') &&
      cliHelpOutput.includes('audio') &&
      cliHelpOutput.includes('video') &&
      cliHelpOutput.includes('music') &&
      cliHelpOutput.includes('sfx'),
    'CLI executable executes with pure node and outputs commands'
  );

  const versionOutput = execSync(
    './node_modules/.bin/mdmedia --version',
    { cwd: SANDBOX_DIR, encoding: 'utf-8', env: childEnv }
  ).trim();
  assert(
    versionOutput === pkgJson.version,
    `Direct shebang execution of ./node_modules/.bin/mdmedia --version outputs ${pkgJson.version} (got ${versionOutput})`
  );

  const audioHelpOutput = execSync(
    './node_modules/.bin/mdmedia audio --help',
    { cwd: SANDBOX_DIR, encoding: 'utf-8', env: childEnv }
  );
  assert(
    audioHelpOutput.includes('--input') && audioHelpOutput.includes('--voice'),
    'CLI subcommand (mdmedia audio --help) resolves flags cleanly'
  );

  // 5. Test Programmatic ESM Runtime Resolution across all 13 subpath exports
  console.log('\n--- 5. Testing Programmatic ESM Runtime Resolution ---');
  const esmTestScript = `
import * as root from 'mdmedia';
import * as audio from 'mdmedia/audio';
import * as video from 'mdmedia/video';
import * as music from 'mdmedia/music';
import * as sfx from 'mdmedia/sfx';
import * as chunker from 'mdmedia/chunker';
import * as pipeline from 'mdmedia/pipeline';
import * as tts from 'mdmedia/tts';
import * as config from 'mdmedia/config';
import * as types from 'mdmedia/types';
import * as narration from 'mdmedia/narration';
import * as markdown from 'mdmedia/markdown';
import * as storage from 'mdmedia/storage';

if (!root.runAudioSynthesis) throw new Error('Missing runAudioSynthesis in mdmedia root');
if (!audio.WavFileStreamSink) throw new Error('Missing WavFileStreamSink in mdmedia/audio');
if (!audio.extractWordTimingsFromPcm) throw new Error('Missing extractWordTimingsFromPcm in mdmedia/audio');
if (!audio.getActiveWordAtPosition) throw new Error('Missing getActiveWordAtPosition in mdmedia/audio');
if (!video.GeminiOmniVideoProvider) throw new Error('Missing GeminiOmniVideoProvider in mdmedia/video');
if (!music.LyriaMusicProvider) throw new Error('Missing LyriaMusicProvider in mdmedia/music');
if (!sfx.ElevenLabsSoundEffectsProvider) throw new Error('Missing ElevenLabsSoundEffectsProvider in mdmedia/sfx');
if (!chunker.prepareDocumentChunks) throw new Error('Missing prepareDocumentChunks in mdmedia/chunker');
if (!chunker.mapChunkToMarkdown) throw new Error('Missing mapChunkToMarkdown in mdmedia/chunker');
if (!pipeline.UniversalEventBus) throw new Error('Missing UniversalEventBus in mdmedia/pipeline');
if (!tts.GeminiTTSProvider) throw new Error('Missing GeminiTTSProvider in mdmedia/tts');
if (!tts.ElevenLabsTTSProvider) throw new Error('Missing ElevenLabsTTSProvider in mdmedia/tts');
if (!config.resolveConfig) throw new Error('Missing resolveConfig in mdmedia/config');
if (!types) throw new Error('Missing mdmedia/types module');
if (!storage.AudioLibrary) throw new Error('Missing AudioLibrary in mdmedia/storage');
if (!narration.GeminiNarrationAdapter) throw new Error('Missing GeminiNarrationAdapter in mdmedia/narration');
if (!markdown.GeminiMarkdownStructureAdapter) throw new Error('Missing GeminiMarkdownStructureAdapter in mdmedia/markdown');

console.log('[ESM Runtime Test] All named exports across all 13 subpaths resolved cleanly!');
`;
  await writeFile(resolve(SANDBOX_DIR, 'consumer.mjs'), esmTestScript);
  execSync('node consumer.mjs', { cwd: SANDBOX_DIR, stdio: 'inherit', env: childEnv });
  assert(true, 'All 13 ESM subpath imports resolve at runtime without errors');

  // 6. Test TypeScript Consumer Declaration Compilation (.d.ts)
  console.log('\n--- 6. Testing TypeScript Type Declaration (.d.ts) Compilation ---');
  const tsconfigConsumer = {
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['consumer.ts'],
  };
  await writeFile(
    resolve(SANDBOX_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfigConsumer, null, 2)
  );

  const tsTestScript = `
import type { RunAudioSynthesisArgs } from 'mdmedia';
import type { StoryboardScene, DocumentHighlight } from 'mdmedia/chunker';
import type { VoiceName, DocumentChunk, IFileReader, PipelineEventMap, SynthesisOptions } from 'mdmedia/types';
import type { GenerateVideoOptions } from 'mdmedia/video';
import type { GenerateMusicOptions } from 'mdmedia/music';
import type { GenerateSoundEffectOptions } from 'mdmedia/sfx';
import type { WordTiming, ChunkTiming } from 'mdmedia/storage';
import type { WordHighlight } from 'mdmedia/audio';
import type { INarrationAdapter } from 'mdmedia/narration';
import type { IMarkdownStructureAdapter } from 'mdmedia/markdown';
import type { ITTSProvider } from 'mdmedia/tts';
import type { ResolvedConfig } from 'mdmedia/config';
import { UniversalEventBus } from 'mdmedia/pipeline';

const scene: StoryboardScene = {
  index: 0,
  prompt: 'Test prompt',
  referenceImages: []
};

const voice: VoiceName = 'Puck';
const opts: GenerateVideoOptions = { aspectRatio: '16:9' };
const musicOpts: GenerateMusicOptions = { outputFormat: 'mp3' };
const sfxOpts: GenerateSoundEffectOptions = { durationSeconds: 2, loop: true };
const bus = new UniversalEventBus();
let runArgs: RunAudioSynthesisArgs | null = null;
let word: WordTiming | null = null;
let chunk: ChunkTiming | null = null;
let highlight: WordHighlight | null = null;
let docHighlight: DocumentHighlight | null = null;
let adapter: INarrationAdapter | null = null;
let mdAdapter: IMarkdownStructureAdapter | null = null;
let ttsProvider: ITTSProvider | null = null;
let resolvedCfg: ResolvedConfig | null = null;
let docChunk: DocumentChunk | null = null;
let reader: IFileReader | null = null;
let evtMap: keyof PipelineEventMap = 'pipeline:complete';
let synthOpts: SynthesisOptions | null = null;

export {
  scene,
  voice,
  opts,
  musicOpts,
  sfxOpts,
  bus,
  runArgs,
  word,
  chunk,
  highlight,
  docHighlight,
  adapter,
  mdAdapter,
  ttsProvider,
  resolvedCfg,
  docChunk,
  reader,
  evtMap,
  synthOpts,
};
`;
  await writeFile(resolve(SANDBOX_DIR, 'consumer.ts'), tsTestScript);
  const tscBin = resolve(process.cwd(), 'node_modules/.bin/tsc');
  const tscCmd = fs.existsSync(tscBin) ? `"${tscBin}"` : 'tsc';
  execSync(`${tscCmd} -p tsconfig.json`, { cwd: SANDBOX_DIR, stdio: 'inherit', env: childEnv });
  assert(true, 'TypeScript compilation against all 13 mdmedia subpath declarations succeeded with 0 errors');

  // Cleanup
  await rm(SANDBOX_DIR, { recursive: true, force: true });

  console.log(`\n=== Package Verification Results: ${passed}/${total} checks passed ===`);
  if (passed !== total) {
    process.exit(1);
  }
}

verifyPackagingAndConsumerHarness().catch((err) => {
  console.error('Fatal package verification error:', err);
  process.exit(1);
});
