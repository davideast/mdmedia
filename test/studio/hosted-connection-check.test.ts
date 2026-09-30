import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../studio/node_modules/@pyric/cli/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const check = fileURLToPath(new URL('../../studio/scripts/check-hosted-connection.mjs', import.meta.url));

async function fixture(mode: 'attached' | 'stalled' | 'wrong-project') {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/__pyric/init.json'
      ? { hosted: true, projectKey: '/fixture/studio', bridgeUrl: `${origin.replace('http:', 'ws:')}/__pyric/sandbox` }
      : { ok: true }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.origin !== origin) { socket.destroy(); return; }
    if (mode === 'stalled') return;
    websocket.handleUpgrade(request, socket, head, peer => {
      peer.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.type !== 'attach') return;
        peer.send(JSON.stringify({
          type: 'attach-ack', protocol: 1, capabilities: ['worker-port'],
          bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'fixture-client',
          projectKey: mode === 'wrong-project' ? '/fixture/other-studio' : '/fixture/studio',
        }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: async () => {
    for (const socket of sockets) socket.destroy();
    websocket.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

async function runCheck(origin: string) {
  const child = spawn('node', [check, origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

test('hosted readiness requires the browser SDK to complete its attachment', async () => {
  const server = await fixture('attached');
  try {
    const result = await runCheck(server.origin);
    expect(result.code).toBe(0);
    expect(result.output).toContain('Browser SDK attached');
  } finally { await server.close(); }
});

test('HTTP 200 does not hide the exact hosted sandbox attach timeout', async () => {
  const server = await fixture('stalled');
  try {
    expect((await fetch(`${server.origin}/api/connectivity`)).status).toBe(200);
    const result = await runCheck(server.origin);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Timed out connecting to the hosted sandbox.');
  } finally { await server.close(); }
}, 10_000);

test('a different sandbox project cannot pass hosted readiness', async () => {
  const server = await fixture('wrong-project');
  try {
    const result = await runCheck(server.origin);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('belongs to a different project');
  } finally { await server.close(); }
});
