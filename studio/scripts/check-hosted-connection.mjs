import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const localEnv = new URL('../.env.local', import.meta.url);
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

const cli = new URL('../node_modules/@pyric/cli/', import.meta.url);
const require = createRequire(new URL('package.json', cli));
const NativeWebSocket = require('ws');
const { getHostedFirestore } = await import(new URL('dist/serve/worker/client/websocket-connection.js', cli));
const { toPageOriginWsUrl } = await import(new URL('dist/serve/entries/bridge-url.js', cli));

/** Exercise Pyric's browser transport, including its five-second attach deadline. */
export async function checkHostedConnection(pageUrl = `http://localhost:${process.env.PORT || '3000'}`) {
  const page = new URL(pageUrl);
  const response = await fetch(new URL('/__pyric/init.json', page), {
    cache: 'no-store', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Pyric initialization returned HTTP ${response.status}.`);
  const configuration = await response.json();
  if (configuration.hosted !== true || typeof configuration.projectKey !== 'string' ||
      !configuration.projectKey || typeof configuration.bridgeUrl !== 'string') {
    throw new Error('Studio did not return hosted Pyric initialization.');
  }

  const url = toPageOriginWsUrl(configuration.bridgeUrl, page, 'page-origin');
  const originalWebSocket = globalThis.WebSocket;
  // Node's native WebSocket cannot send the browser Origin header. Use Pyric's
  // ws dependency so the actual bridge Host/Origin guard is exercised too.
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(endpoint) { super(endpoint, { origin: page.origin }); }
  };
  let client;
  const began = performance.now();
  try {
    await new Promise((resolveAttachment, reject) => {
      client = getHostedFirestore({
        url, projectKey: configuration.projectKey,
        onConnection(state) { if (state === 'attached') resolveAttachment(); },
        onError(error) { reject(error); },
      });
    });
    return { endpoint: url, elapsedMs: Math.round(performance.now() - began) };
  } finally {
    client?.port.close();
    globalThis.WebSocket = originalWebSocket;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await checkHostedConnection(process.argv[2]);
    console.log(`Browser SDK attached to ${result.endpoint} in ${result.elapsedMs}ms.`);
  } catch (error) {
    console.error(`Hosted connection check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
