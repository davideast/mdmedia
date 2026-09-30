import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = process.argv[2];
if (!host || !/^[a-z0-9.-]+\.ts\.net$/i.test(host)) {
  throw new Error('Usage: node scripts/install-launch-agents.mjs <device>.<tailnet>.ts.net');
}

const agents = join(homedir(), 'Library', 'LaunchAgents');
const logs = join(homedir(), 'Library', 'Logs');
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const item = (value) => `<string>${xml(value)}</string>`;
const args = (values) => `<array>${values.map(item).join('')}</array>`;
const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
const path = `${join(studio, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

const studioAgent = plist(`
  <key>Label</key>${item('com.mdmedia.studio')}
  <key>ProgramArguments</key>${args([
    process.execPath, join(studio, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js'),
    'sandbox', '--hosted', '--allowed-host', host, '--no-open', '--',
    join(studio, 'node_modules', '.bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', '3000',
  ])}
  <key>WorkingDirectory</key>${item(studio)}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${item(path)}<key>PYRIC_SANDBOX_FORCE</key>${item('1')}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${item(join(logs, 'mdmedia-studio.out.log'))}
  <key>StandardErrorPath</key>${item(join(logs, 'mdmedia-studio.err.log'))}
`);

const tailscaleAgent = plist(`
  <key>Label</key>${item('com.mdmedia.studio.tailscale')}
  <key>ProgramArguments</key>${args(['/bin/sh', join(studio, 'scripts', 'configure-tailscale-serve.sh')])}
  <key>EnvironmentVariables</key><dict><key>PATH</key>${item(path)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${item(join(logs, 'mdmedia-studio-tailscale.out.log'))}
  <key>StandardErrorPath</key>${item(join(logs, 'mdmedia-studio-tailscale.err.log'))}
`);

await mkdir(agents, { recursive: true });
await mkdir(logs, { recursive: true });
await writeFile(join(agents, 'com.mdmedia.studio.plist'), studioAgent);
await writeFile(join(agents, 'com.mdmedia.studio.tailscale.plist'), tailscaleAgent);
console.log(`Installed Studio launch agents for ${host} in ${agents}`);
