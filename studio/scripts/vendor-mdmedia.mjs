import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(studio);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: 'inherit' });
run(['run', 'build'], root);
run(['pack', '--pack-destination', root], root);
run(['install', 'mdmedia@file:../mdmedia-0.1.0.tgz', '--force'], studio);
console.log(`Studio engine refreshed at ${join(studio, 'node_modules/mdmedia')}.`);
