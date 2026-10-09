import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(studio);
// Caller variables take precedence; .env.local takes precedence over .env.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const port = process.env.PORT || '3000';
const backendPort = process.env.MDMEDIA_PYRIC_PORT || '3473';
const action = process.argv[2] || 'start';
const next = join(studio, 'node_modules/next/dist/bin/next');
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PYRIC_SANDBOX_FORCE: '1',
  PYRIC_SANDBOX: `remote:http://127.0.0.1:${backendPort}`,
  PATH: `${dirname(process.execPath)}:${join(studio, 'node_modules/.bin')}:${process.env.PATH || '/usr/bin:/bin'}`,
};

async function run(args, overrides = {}) {
  const child = spawn(process.execPath, args, { cwd: studio, env: { ...env, ...overrides }, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Hosted ${action} exited with ${signal || code}.`));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  if (action === 'build') {
    const dist = '.next-hosted-staged';
    await run([next, 'build', '--webpack'], { MDMEDIA_DIST_DIR: dist });
    await run(['scripts/build-offline-worker.mjs', dist, `${dist}/sw.js`]);
  } else if (action === 'preview') {
    await copyFile('.next-hosted-staged/sw.js', 'public/sw-preview.js');
    await run([next, 'start', '--hostname', '127.0.0.1', '--port', process.env.MDMEDIA_PREVIEW_PORT || '3100'], {
      MDMEDIA_DIST_DIR: '.next-hosted-staged',
      NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import ${pathToFileURL(join(studio, 'node_modules/@pyric/cli/dist/register/index.js')).href}`.trim(),
    });
  } else if (action === 'start') {
    if (!existsSync('.next-hosted/BUILD_ID')) throw new Error('No live hosted build. Build and release Studio first.');
    await run([
      'node_modules/@pyric/cli/dist/cli/index.js', 'sandbox', '--hosted', '--no-open',
      '--host', '127.0.0.1', '--port', backendPort,
      ...(process.env.MDMEDIA_ALLOWED_DEV_ORIGINS ? ['--allowed-host', process.env.MDMEDIA_ALLOWED_DEV_ORIGINS] : []),
      '--', next, 'start', '--hostname', '127.0.0.1', '--port', port,
    ], { MDMEDIA_DIST_DIR: '.next-hosted' });
  } else {
    throw new Error('Usage: node scripts/hosted-server.mjs build|preview|start');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
