import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkHostedConnection } from './check-hosted-connection.mjs';

const live = '.next-hosted';
const staged = '.next-hosted-staged';
const backup = `.next-hosted-previous-${Date.now()}-${process.pid}`;
const worker = 'public/sw.js';
const agent = join(homedir(), 'Library/LaunchAgents/com.mdmedia.studio.plist');
const target = `gui/${process.getuid()}/com.mdmedia.studio`;

function launchctl(...args) {
  execFileSync('launchctl', args, { stdio: 'inherit' });
}

async function bootstrap() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, agent], { stdio: 'pipe' });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/connectivity', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch { /* The agent is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Studio did not become healthy on port 3000 within 30 seconds.');
}

if (!existsSync(join(live, 'BUILD_ID')) ||
    !existsSync(join(staged, 'BUILD_ID')) ||
    !existsSync(join(staged, 'sw.js')) ||
    !existsSync(agent)) {
  throw new Error('A live build, staged build, worker, and installed LaunchAgent are required.');
}

const stagedBuildId = (await readFile(join(staged, 'BUILD_ID'), 'utf8')).trim();
const stagedWorker = await readFile(join(staged, 'sw.js'), 'utf8');
if (!stagedWorker.includes(`mdmedia-app-${stagedBuildId}`)) {
  throw new Error('The staged service worker does not match the staged build.');
}

const oldWorker = existsSync(worker) ? await readFile(worker) : null;
let stopped = false;
let liveMoved = false;
let stagedMoved = false;

try {
  launchctl('bootout', target);
  stopped = true;
  await rename(live, backup);
  liveMoved = true;
  await rename(staged, live);
  stagedMoved = true;
  await copyFile(join(live, 'sw.js'), worker);
  await bootstrap();
  await waitForServer();
  await checkHostedConnection('http://127.0.0.1:3000');
  console.log(`Studio released. Previous build kept at ${backup}.`);
} catch (error) {
  if (stopped) {
    try { launchctl('bootout', target); } catch { /* The new agent may not be loaded. */ }
    if (stagedMoved) await rename(live, staged);
    if (liveMoved) await rename(backup, live);
    if (oldWorker) await writeFile(worker, oldWorker);
    else await unlink(worker).catch(() => {});
    try { await bootstrap(); }
    catch (restartError) {
      console.error('Could not restart the previous Studio build:', restartError);
    }
  }
  throw error;
}
