#!/usr/bin/env node
import { runMain } from 'citty';
import { mainCommand, resolveSmartCliArgv } from './cli/command.js';

runMain(mainCommand, { rawArgs: resolveSmartCliArgv(process.argv.slice(2)) });
