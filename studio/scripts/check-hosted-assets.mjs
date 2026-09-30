import { checkHostedConnection } from './check-hosted-connection.mjs';

const origin = process.argv[2] || 'http://127.0.0.1:3000';
const workerPath = new URL(origin).port === '3100' ? '/sw-preview.js' : '/sw.js';
const assets = new Set();

async function get(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

for (const route of ['/studio', '/downloads']) {
  const html = await get(route);
  for (const asset of html.match(/\/_next\/static\/[^"'\\\s<>]+\.(?:js|css)/g) || []) {
    assets.add(asset);
  }
}

const worker = await get(workerPath);
const required = worker.match(/^const REQUIRED = (.*);$/m);
if (!required) throw new Error('Service worker has no REQUIRED precache list.');
for (const asset of JSON.parse(required[1])) assets.add(asset);

await get('/api/connectivity');
const results = await Promise.all([...assets].map(async (asset) => {
  try { await get(asset); return null; }
  catch (error) { return error.message; }
}));
const failures = results.filter(Boolean);
if (failures.length) throw new Error(failures.join('\n'));
await checkHostedConnection(origin);
console.log(`${origin}: 2 pages, health endpoint, ${assets.size} assets return 200; browser SDK attached to Pyric.`);
