#!/usr/bin/env node
/**
 * Background runner and lifecycle manager for Pyric Node Hosted Dev Server.
 *
 * Runs `pyric sandbox --hosted -- next dev --port 3000` in the background,
 * storing the process PID in a gitignored `.dev.pid` and streaming output to
 * `.dev.log`.
 *
 * Supports commands: start, stop, restart, status, logs
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STUDIO_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(STUDIO_DIR, '.dev.pid');
const LOG_FILE = path.join(STUDIO_DIR, '.dev.log');
const PORT = process.env.PORT || '3000';

function killPortListeners(port) {
  try {
    const raw = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (!raw) return;
    const pids = raw.split('\n').map((p) => parseInt(p.trim(), 10)).filter(Boolean);
    for (const p of pids) {
      if (p !== process.pid && isPidAlive(p)) {
        try { process.kill(p, 'SIGKILL'); } catch {}
      }
    }
  } catch {}
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRunningPid() {
  if (!fs.existsSync(PID_FILE)) {
    return null;
  }
  const content = fs.readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(content, 10);
  if (Number.isNaN(pid) || pid <= 0) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
  if (!isPidAlive(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
  return pid;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  const existingPid = getRunningPid();
  if (existingPid) {
    console.log(`[studio-dev] Server is already running in background.`);
    console.log(`  PID:  ${existingPid}`);
    console.log(`  Logs: ${LOG_FILE}`);
    console.log(`  URL:  http://localhost:${PORT}`);
    return;
  }

  // Ensure log file parent directory exists
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  // Clean any orphaned processes listening on ports
  killPortListeners(PORT);
  killPortListeners(3473);

  const logFd = fs.openSync(LOG_FILE, 'a');
  const timestamp = new Date().toISOString();
  fs.writeSync(logFd, `\n\n=== Studio Dev Server started at ${timestamp} (Port ${PORT}) ===\n\n`);

  console.log(`[studio-dev] Launching pyric sandbox --hosted -- next dev --port ${PORT}...`);

  const child = spawn(
    'npx',
    ['pyric', 'sandbox', '--hosted', '--', 'next', 'dev', '--port', PORT],
    {
      cwd: STUDIO_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        PORT,
      },
    }
  );

  fs.closeSync(logFd);

  const pid = child.pid;
  fs.writeFileSync(PID_FILE, `${pid}\n`, 'utf8');
  child.unref();

  // Wait 1.5s to verify startup stability
  await sleep(1500);

  if (!isPidAlive(pid)) {
    console.error(`[studio-dev] Failed: Server process (PID: ${pid}) exited immediately.`);
    console.error(`Recent log output from ${LOG_FILE}:`);
    printRecentLogs(25);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(1);
  }

  console.log(`[studio-dev] Successfully started in background!`);
  console.log(`  PID:      ${pid}`);
  console.log(`  PID File: ${PID_FILE}`);
  console.log(`  Log File: ${LOG_FILE}`);
  console.log(`  App URL:  http://localhost:${PORT}`);
  console.log(`  Command:  npm run dev:logs (or npm run dev:stop)`);
}

async function stop() {
  const pid = getRunningPid();
  if (!pid) {
    console.log(`[studio-dev] No running server found (clean state).`);
    if (fs.existsSync(PID_FILE)) {
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
    return;
  }

  console.log(`[studio-dev] Gracefully stopping dev server (PID: ${pid})...`);

  // Deliver SIGINT to process group so Pyric can cleanly drain SQLite and close
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    try {
      process.kill(pid, 'SIGINT');
    } catch {}
  }

  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      break;
    }
    await sleep(250);
  }

  if (isPidAlive(pid)) {
    console.log(`[studio-dev] Process still alive after 5s; sending SIGTERM...`);
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await sleep(1500);
  }

  if (isPidAlive(pid)) {
    console.log(`[studio-dev] Process still alive; sending SIGKILL...`);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await sleep(500);
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {}

  killPortListeners(PORT);
  killPortListeners(3473);

  console.log(`[studio-dev] Server stopped successfully.`);
}

function printRecentLogs(lineCount = 30) {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`  (No logs written yet to ${LOG_FILE})`);
    return;
  }
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const slice = lines.slice(-lineCount);
    console.log(slice.join('\n'));
  } catch (err) {
    console.error(`  Failed to read log file: ${err.message}`);
  }
}

function status() {
  const pid = getRunningPid();
  if (!pid) {
    console.log(`[studio-dev] Status: NOT RUNNING`);
    console.log(`  PID File: ${PID_FILE} (absent)`);
    console.log(`  Log File: ${LOG_FILE}`);
    return;
  }

  console.log(`[studio-dev] Status: RUNNING`);
  console.log(`  PID:      ${pid}`);
  console.log(`  PID File: ${PID_FILE}`);
  console.log(`  Log File: ${LOG_FILE}`);
  console.log(`  App URL:  http://localhost:${PORT}`);
  console.log(`\n--- Recent Log Output (${LOG_FILE}) ---`);
  printRecentLogs(15);
}

function logs(follow = false) {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`[studio-dev] Log file ${LOG_FILE} does not exist yet.`);
    return;
  }

  if (follow) {
    const tail = spawn('tail', ['-f', '-n', '50', LOG_FILE], { stdio: 'inherit' });
    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  } else {
    printRecentLogs(50);
  }
}

// CLI entry point
const action = process.argv[2] || 'start';

switch (action) {
  case 'start':
    await start();
    break;
  case 'stop':
    await stop();
    break;
  case 'restart':
    await stop();
    await start();
    break;
  case 'status':
    status();
    break;
  case 'logs': {
    const follow = process.argv.includes('-f') || process.argv.includes('--follow');
    logs(follow);
    break;
  }
  default:
    console.error(`Unknown action: "${action}". Valid actions: start, stop, restart, status, logs`);
    process.exit(1);
}
