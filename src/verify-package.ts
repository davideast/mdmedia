import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SANDBOX_DIR = '/tmp/mdmedia-consumer-sandbox';

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

  // 1. Build production bundle
  console.log('\n--- 1. Building Production Package (dist/) ---');
  execSync('bun run build', { stdio: 'inherit' });
  assert(fs.existsSync(resolve(process.cwd(), 'dist', 'bin.js')), 'dist/bin.js emitted');
  assert(fs.existsSync(resolve(process.cwd(), 'dist', 'index.d.ts')), 'dist/index.d.ts emitted');

  // 2. Pack npm tarball
  console.log('\n--- 2. Generating npm Package Tarball (npm pack) ---');
  const packOutput = execSync('npm pack --quiet', { encoding: 'utf-8' }).trim();
  const tarballPath = resolve(process.cwd(), packOutput);
  assert(fs.existsSync(tarballPath), `Tarball created: ${packOutput}`);

  // 3. Prepare Consumer Sandbox
  console.log('\n--- 3. Creating Consumer Sandbox & Installing Package ---');
  if (fs.existsSync(SANDBOX_DIR)) {
    await rm(SANDBOX_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

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

  execSync('npm install --no-package-lock --silent', { cwd: SANDBOX_DIR });
  assert(
    fs.existsSync(resolve(SANDBOX_DIR, 'node_modules', 'mdmedia')),
    'mdmedia installed into consumer node_modules'
  );
  assert(
    fs.existsSync(resolve(SANDBOX_DIR, 'node_modules', '.bin', 'mdmedia')),
    'mdmedia CLI binary installed into node_modules/.bin'
  );

  // 4. Test Pure Node CLI Executable
  console.log('\n--- 4. Testing CLI Executable in Pure Standard Node.js ---');
  const cliOutput = execSync(
    'node ./node_modules/.bin/mdmedia --help',
    { cwd: SANDBOX_DIR, encoding: 'utf-8' }
  );
  assert(
    cliOutput.includes('mdmedia') &&
      cliOutput.includes('audio') &&
      cliOutput.includes('video'),
    'CLI executable executes with pure node and outputs commands'
  );

  // 5. Test Programmatic ESM Runtime Resolution across all subpath exports
  console.log('\n--- 5. Testing Programmatic ESM Runtime Resolution ---');
  const esmTestScript = `
import * as root from 'mdmedia';
import * as audio from 'mdmedia/audio';
import * as video from 'mdmedia/video';
import * as chunker from 'mdmedia/chunker';
import * as pipeline from 'mdmedia/pipeline';
import * as config from 'mdmedia/config';
import * as storage from 'mdmedia/storage';
import * as studio from 'mdmedia/studio';
import * as narration from 'mdmedia/narration';
import * as tui from 'mdmedia/tui';

if (!audio.WavFileStreamSink) throw new Error('Missing WavFileStreamSink in mdmedia/audio');
if (!audio.extractWordTimingsFromPcm) throw new Error('Missing extractWordTimingsFromPcm in mdmedia/audio');
if (!audio.getActiveWordAtPosition) throw new Error('Missing getActiveWordAtPosition in mdmedia/audio');
if (!video.GeminiOmniVideoProvider) throw new Error('Missing GeminiOmniVideoProvider in mdmedia/video');
if (!chunker.prepareDocumentChunks) throw new Error('Missing prepareDocumentChunks in mdmedia/chunker');
if (!chunker.mapChunkToMarkdown) throw new Error('Missing mapChunkToMarkdown in mdmedia/chunker');
if (!pipeline.UniversalEventBus) throw new Error('Missing UniversalEventBus in mdmedia/pipeline');
if (!config.resolveConfig) throw new Error('Missing resolveConfig in mdmedia/config');
if (!storage.AudioLibrary) throw new Error('Missing AudioLibrary in mdmedia/storage');
if (!studio.StudioStore) throw new Error('Missing StudioStore in mdmedia/studio');
if (!studio.NarrationRecorder) throw new Error('Missing NarrationRecorder in mdmedia/studio');
if (!studio.buildHighlightedMarkdownBlocks) throw new Error('Missing buildHighlightedMarkdownBlocks in mdmedia/studio');
if (!narration.GeminiNarrationAdapter) throw new Error('Missing GeminiNarrationAdapter in mdmedia/narration');
if (!tui.StudioApp) throw new Error('Missing StudioApp in mdmedia/tui');

console.log('[ESM Runtime Test] All named exports from all subpaths resolved cleanly!');
`;
  await writeFile(resolve(SANDBOX_DIR, 'consumer.mjs'), esmTestScript);
  execSync('node consumer.mjs', { cwd: SANDBOX_DIR, stdio: 'inherit' });
  assert(true, 'ESM subpath imports resolve at runtime without errors');

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
import type { StoryboardScene } from 'mdmedia/chunker';
import type { DocumentHighlight } from 'mdmedia/chunker';
import type { VoiceName } from 'mdmedia/types';
import type { GenerateVideoOptions } from 'mdmedia/video';
import type { StudioState } from 'mdmedia/studio';
import type { WordTiming, ChunkTiming } from 'mdmedia/storage';
import type { WordHighlight } from 'mdmedia/audio';
import type { INarrationAdapter } from 'mdmedia/narration';
import { UniversalEventBus } from 'mdmedia/pipeline';

const scene: StoryboardScene = {
  index: 0,
  prompt: 'Test prompt',
  referenceImages: []
};

const voice: VoiceName = 'Puck';
const opts: GenerateVideoOptions = { aspectRatio: '16:9' };
const bus = new UniversalEventBus();
let state: StudioState | null = null;
let word: WordTiming | null = null;
let chunk: ChunkTiming | null = null;
let highlight: WordHighlight | null = null;
let docHighlight: DocumentHighlight | null = null;
let adapter: INarrationAdapter | null = null;

export { scene, voice, opts, bus, state, word, chunk, highlight, docHighlight, adapter };
`;
  await writeFile(resolve(SANDBOX_DIR, 'consumer.ts'), tsTestScript);
  const tscBin = resolve(process.cwd(), 'node_modules/.bin/tsc');
  const tscCmd = fs.existsSync(tscBin) ? `"${tscBin}"` : 'tsc';
  execSync(`${tscCmd} -p tsconfig.json`, { cwd: SANDBOX_DIR, stdio: 'inherit' });
  assert(true, 'TypeScript compilation against mdmedia declarations succeeded with 0 errors');

  // Cleanup
  await rm(SANDBOX_DIR, { recursive: true, force: true });
  await rm(tarballPath, { force: true });

  console.log(`\n=== Package Verification Results: ${passed}/${total} checks passed ===`);
  if (passed !== total) {
    process.exit(1);
  }
}

verifyPackagingAndConsumerHarness().catch((err) => {
  console.error('Fatal package verification error:', err);
  process.exit(1);
});
