import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = dirname(dirname(fileURLToPath(import.meta.url)));
// Escape systemd specifiers and quoted argument syntax in machine paths.
const quoted = (value) => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const unit = `[Unit]
Description=mdmedia Studio and persistent local Pyric sandbox
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${studio.replaceAll('%', '%%')}
ExecStart=${quoted(process.execPath)} ${quoted(join(studio, 'scripts/hosted-server.mjs'))} start
Restart=always
RestartSec=5
KillMode=control-group
KillSignal=SIGINT
TimeoutStopSec=45
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mdmedia-studio

[Install]
WantedBy=default.target
`;
const directory = join(homedir(), '.config/systemd/user');
await mkdir(directory, { recursive: true });
const destination = join(directory, 'mdmedia-studio.service');
await writeFile(destination, unit);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'mdmedia-studio.service'], { stdio: 'inherit' });
console.log(`Installed ${destination}. Start after releasing a hosted build.`);
