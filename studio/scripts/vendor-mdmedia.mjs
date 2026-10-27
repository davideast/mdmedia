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
// The forced install reinstalls `pyric`, wiping the patches that the studio
// postinstall applied. Without them the sandbox lacks the email_verified claim
// and the allowlist rule rejects every sign-in, so re-apply the patch here.
execFileSync(process.execPath, [join(studio, 'scripts/patch-pyric-bridge-port.js')], { cwd: studio, stdio: 'inherit' });
console.log(`Studio engine refreshed at ${join(studio, 'node_modules/mdmedia')}.`);
