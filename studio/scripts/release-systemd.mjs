import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(studio);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const unit = 'mdmedia-studio.service';
const live = '.next-hosted';
const staged = '.next-hosted-staged';
const suffix = `${Date.now()}-${process.pid}`;
const backup = `.next-hosted-previous-${suffix}`;
const worker = 'public/sw.js';
const origin = `http://127.0.0.1:${process.env.PORT || '3000'}`;
const initial = !existsSync(join(live, 'BUILD_ID'));
const hadDevServer = initial && existsSync('.dev.pid');
const systemctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });

if (!existsSync(join(staged, 'BUILD_ID')) || !existsSync(join(staged, 'sw.js'))) {
  throw new Error('Run node scripts/hosted-server.mjs build before releasing.');
}
const buildId = (await readFile(join(staged, 'BUILD_ID'), 'utf8')).trim();
if (!(await readFile(join(staged, 'sw.js'), 'utf8')).includes(`mdmedia-app-${buildId}`)) {
  throw new Error('The staged service worker does not match the staged build.');
}
// Fail before stopping anything if the service has not been installed.
execFileSync('systemctl', ['--user', 'cat', unit], { stdio: 'pipe' });
const oldWorker = existsSync(worker) ? await readFile(worker) : null;
let liveMoved = false;
let stagedMoved = false;
let stopped = false;

try {
  systemctl('stop', unit);
  stopped = true;
  if (hadDevServer) execFileSync(process.execPath, ['scripts/dev-hosted.mjs', 'stop'], { stdio: 'inherit' });
  // Both hosts are stopped, so SQLite's database and WAL can be copied together.
  if (existsSync('.pyric/state/hosted')) {
    const stateBackup = `.pyric/backups/hosted-${suffix}`;
    await cp('.pyric/state/hosted', stateBackup, { recursive: true });
    console.log(`Sandbox backup: ${stateBackup}`);
  }
  if (existsSync(live)) {
    await rename(live, backup);
    liveMoved = true;
  }
  await rename(staged, live);
  stagedMoved = true;
  await copyFile(join(live, 'sw.js'), worker);
  systemctl('start', unit);

  const deadline = Date.now() + 180_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/connectivity`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { healthy = true; break; }
    } catch { /* The sandbox and app are still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy) throw new Error('Studio did not become healthy within three minutes.');
  execFileSync(process.execPath, ['scripts/check-hosted-assets.mjs', origin], { stdio: 'inherit' });
  console.log(`Released Studio build ${buildId}.${liveMoved ? ` Previous build: ${backup}` : ''}`);
} catch (error) {
  if (stopped) {
    try { systemctl('stop', unit); } catch { /* Continue restoring files. */ }
    if (stagedMoved) await rename(live, staged);
    if (liveMoved) await rename(backup, live);
    if (oldWorker) await writeFile(worker, oldWorker);
    else await unlink(worker).catch(() => {});
    if (!initial) systemctl('start', unit);
    else if (hadDevServer) execFileSync(process.execPath, ['scripts/dev-hosted.mjs', 'start'], { stdio: 'inherit' });
    console.error('Restored the previous Studio server.');
  }
  throw error;
}

