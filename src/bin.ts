#!/usr/bin/env node
import { runMain } from 'citty';
import { mainCommand, resolveSmartCliArgv } from './cli/command.js';

// Load API keys from ./.env like Bun does. Existing environment variables win,
// and Node versions before 20.12 (no loadEnvFile) simply skip this.
try {
  process.loadEnvFile?.();
} catch {
  // No .env in the working directory.
}

runMain(mainCommand, { rawArgs: resolveSmartCliArgv(process.argv.slice(2)) });
