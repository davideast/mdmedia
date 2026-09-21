const fs = require('fs');
const path = require('path');

const cliDist = path.join(__dirname, '..', 'node_modules', '@pyric', 'cli', 'dist');

// 1. Patch bridge-url.js to preserve bridge port under Next.js
const bridgeUrlPath = path.join(cliDist, 'serve', 'entries', 'bridge-url.js');
if (fs.existsSync(bridgeUrlPath)) {
  let content = fs.readFileSync(bridgeUrlPath, 'utf8');
  const targetPattern = "const usesSeparateBridgePort = routing === 'bridge-port';";
  const replacement = "const usesSeparateBridgePort = routing === 'bridge-port' || (rawUrl.port.length > 0 && rawUrl.port !== locUrl.port);";
  if (content.includes(targetPattern)) {
    content = content.replace(targetPattern, replacement);
    fs.writeFileSync(bridgeUrlPath, content, 'utf8');
    console.log('[patch] Patched bridge-url.js to preserve bridge port under Next.js');
  }
}

// 2. Patch storage.js to uncap MAX_STORAGE_OP_BYTES for Node hosted SQLite storage (up to 512 MiB)
const storageProtocolPath = path.join(cliDist, 'serve', 'worker', 'protocol', 'storage.js');
if (fs.existsSync(storageProtocolPath)) {
  let content = fs.readFileSync(storageProtocolPath, 'utf8');
  const targetCap = "export const MAX_STORAGE_OP_BYTES = 8 * 1024 * 1024;";
  const replacementCap = "export const MAX_STORAGE_OP_BYTES = 512 * 1024 * 1024;";
  if (content.includes(targetCap)) {
    content = content.replace(targetCap, replacementCap);
    fs.writeFileSync(storageProtocolPath, content, 'utf8');
    console.log('[patch] Patched MAX_STORAGE_OP_BYTES to 512 MiB');
  }
}

// 3. Patch bridge protocol.js to uncap MAX_BRIDGE_FRAME_BYTES (up to 768 MiB)
const bridgeProtocolPath = path.join(cliDist, 'bridge', 'protocol.js');
if (fs.existsSync(bridgeProtocolPath)) {
  let content = fs.readFileSync(bridgeProtocolPath, 'utf8');
  const targetFrame = "export const MAX_BRIDGE_FRAME_BYTES = 12 * 1024 * 1024;";
  const replacementFrame = "export const MAX_BRIDGE_FRAME_BYTES = 768 * 1024 * 1024;";
  const targetQueued = "export const MAX_QUEUED_OPERATION_BYTES = 24 * 1024 * 1024;";
  const replacementQueued = "export const MAX_QUEUED_OPERATION_BYTES = 768 * 1024 * 1024;";
  let changed = false;
  if (content.includes(targetFrame)) {
    content = content.replace(targetFrame, replacementFrame);
    changed = true;
  }
  if (content.includes(targetQueued)) {
    content = content.replace(targetQueued, replacementQueued);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(bridgeProtocolPath, content, 'utf8');
    console.log('[patch] Patched MAX_BRIDGE_FRAME_BYTES and MAX_QUEUED_OPERATION_BYTES to 768 MiB');
  }
}

// 4. Patch pyric-admin/dist/storage/index.js MAX_REMOTE_STORAGE_OP_BYTES (up to 512 MiB)
const adminStoragePath = path.join(__dirname, '..', 'node_modules', 'pyric-admin', 'dist', 'storage', 'index.js');
if (fs.existsSync(adminStoragePath)) {
  let content = fs.readFileSync(adminStoragePath, 'utf8');
  const targetAdminCap = "const MAX_REMOTE_STORAGE_OP_BYTES = 8 * 1024 * 1024;";
  const replacementAdminCap = "const MAX_REMOTE_STORAGE_OP_BYTES = 512 * 1024 * 1024;";
  if (content.includes(targetAdminCap)) {
    content = content.replace(targetAdminCap, replacementAdminCap);
    fs.writeFileSync(adminStoragePath, content, 'utf8');
    console.log('[patch] Patched pyric-admin MAX_REMOTE_STORAGE_OP_BYTES to 512 MiB');
  }
}

// 5. Patch bridge/server/socket-message.js backlog limit (up to 768 MiB)
const socketMessagePath = path.join(cliDist, 'bridge', 'server', 'socket-message.js');
if (fs.existsSync(socketMessagePath)) {
  let content = fs.readFileSync(socketMessagePath, 'utf8');
  const targetBacklog = "socket.bufferedAmount + Buffer.byteLength(payload) > 24 * 1024 * 1024;";
  const replacementBacklog = "socket.bufferedAmount + Buffer.byteLength(payload) > 768 * 1024 * 1024;";
  if (content.includes(targetBacklog)) {
    content = content.replace(targetBacklog, replacementBacklog);
    content = content.replace("Client output backlog exceeds 24 MiB", "Client output backlog exceeds 768 MiB");
    fs.writeFileSync(socketMessagePath, content, 'utf8');
    console.log('[patch] Patched socket-message.js backlog cap to 768 MiB');
  }
}

