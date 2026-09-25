# PYRIC.md — operator notes

How local development works in this app, what is broken upstream, and what was
worked around to get it running.

- Pyric version: **`@pyric/cli` 0.1.0-alpha.23** (conformance-tested against Firebase 12.13.0)
- Installed from a **local checkout**, not npm: `/Users/deast/repos/davideast/pyric`
- App: Next.js 16.3.5, App Router, Turbopack, npm

---

## 1. Running it

```sh
cd studio
npm run dev
```

That runs:

```sh
pyric sandbox --bridge --persist -- next dev --port 3000
```

| URL | What |
|---|---|
| http://localhost:3000 | the app |
| http://localhost:3000/__pyric/ui/studio | Pyric Studio (proxied through the Next rewrite) |
| http://localhost:3473 | the Pyric host directly |
| http://localhost:3473/__pyric/health | health probe |

Sign in with the **"Continue with Google"** button. Under the sandbox this opens
Pyric's identity picker (email + display name + optional custom-claims JSON)
instead of a real Google window. No OAuth setup, no test accounts in app code.

> [!IMPORTANT]
> The sandbox runs **inside the browser tab** (SharedWorker mode). Keep a tab
> open or Firestore/auth data and persistence stop. On startup Pyric waits 30s
> for a tab before launching `next dev` — that delay is normal.

Stop with **Ctrl-C**, never `kill -9`, so the persisted store drains to
`.pyric/state/state.json`.

### Other scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Pyric sandbox + Next dev (the normal one) |
| `npm run dev:direct` | plain `next dev`, no sandbox — **will throw** (see §3.5) |
| `npm run rules:build` | resolve both modular rules files |
| `npm run rules:build:firestore` | `firestore.modules.rules` → `firestore.rules` |
| `npm run rules:build:storage` | `storage.modules.rules` → `storage.rules` |

`pyric.json` points the dev sandbox at the **`*.modules.rules`** sources (Pyric
resolves `rules_version = '2+modules'` in memory). `firebase.json` points at the
**resolved** `firestore.rules` / `storage.rules`, which is what gets deployed.
Run `npm run rules:build` before deploying.

> [!NOTE]
> `pyric sandbox` does **not** auto-detect `*.modules.rules` — that precedence is
> Vite-plugin-only (`serve/vite-rules-source.ts`). The `rules` object in
> `pyric.json` is therefore mandatory here.
>
> Firestore rules hot-reload on save. **Storage rules do not** — restart the host.

### Reinstalling Pyric after pulling the checkout

```sh
cd studio
bash /Users/deast/repos/davideast/pyric/.agents/skills/pyric-node-host/scripts/pack-local.sh \
  /Users/deast/repos/davideast/pyric .pyric-local
npm install --save-dev ./.pyric-local/pyric-*.tgz ./.pyric-local/create-pyric-*.tgz
npx --no-install pyric --version
```

All four tarballs must be installed in **one** command — `@pyric/cli` depends on
the other three at a version that only exists in these tarballs. Requires `bun`
and `npm` on PATH and Node ≥ 22.15. `.pyric-local/` and `.pyric/` are gitignored;
do not commit the `file:` dependency lines.

---

## 2. How the sandbox substitution works

The application source is **plain, standard Firebase**. There are no Pyric
imports, no `initializeSandbox()`, and no sandbox branches in `src/lib/` or
`src/app/`. Substitution happens at resolution time:

- **Browser** — `withPyric` rewrites the eight `firebase/*` specifiers to
  `@pyric/cli/dist/serve/entries/*.js` via Turbopack `resolveAlias`.
- **Server** — `pyric sandbox` sets `NODE_OPTIONS=--import @pyric/cli/register`,
  whose loader hook maps `firebase → pyric` and `firebase-admin → pyric-admin`.
  `serverExternalPackages: ['firebase','firebase-admin']` stops Next inlining
  them so the hook still applies.
- **Production** — `withPyric` is an identity passthrough under
  `NODE_ENV=production`, and the register hook is inert unless `PYRIC_SANDBOX`
  is set. `next build` ships no Pyric code.

---

## 3. Upstream Pyric bugs found (worth reporting to the maintainers)

All four were hit while wiring this app up. Line numbers refer to the installed
`0.1.0-alpha.23` build under `studio/node_modules/`.

### 3.1 `@pyric/cli`'s `./next` export has no `require` condition

**This makes the documented Next.js integration fail outright on Next 16.**

`packages/cli/package.json` exports:

```json
"./next": {
  "types": "./dist/next/index.d.ts",
  "import": "./dist/next/index.js"
}
```

There is no `require` condition, no `default`, and no root (`.`) export.

Next 16 compiles `next.config.ts` into `next.config.compiled.js` as
**CommonJS** — verified by probing from inside the config:

```ts
// next.config.ts
console.log(typeof require, typeof module, typeof __dirname);
// → "function function string"  (i.e. CJS)
```

So the documented line `import { withPyric } from '@pyric/cli/next'` is
downlevelled to `require('@pyric/cli/next')` and dies:

```
⨯ Failed to load next.config.ts
Error: Package subpath './next' is not defined by "exports" in
  .../node_modules/@pyric/cli/package.json
ERR_PACKAGE_PATH_NOT_EXPORTED
```

Minimal repro:

```sh
node -e "require('@pyric/cli/next')"                  # throws
node --input-type=module -e "import('@pyric/cli/next')" # works
```

> [!WARNING]
> Testing only the ESM form hides this bug. It is easy to misdiagnose as an
> `npm install` race, because the symptom is also "module not found".

**Suggested upstream fix:** add a `require` condition (or a CJS build) for
`./next`, and export `./package.json` so consumers can resolve the package root.

**Workaround here:** `next.config.ts` exports an **async function** and pulls the
adapter in with a dynamic `import()` of an absolute `file://` URL, which bypasses
the exports map. The import is built through `new Function` because Next's
transpiler rewrites a literal `await import(x)` into `require(x)`, which cannot
take a URL (`Cannot find module 'file:///...'`).

### 3.2 `withPyric` writes absolute paths into `turbopack.resolveAlias`

`src/next/client-aliases.ts` → `defaultSdkEntries()` produces absolute
filesystem paths:

```
firebase/auth → /Users/.../node_modules/@pyric/cli/dist/serve/entries/auth.js
```

Turbopack reads a value starting with `/` as a **server-relative URL**, not a
path, and fails:

```
Module not found: Can't resolve './Users/deast/.../dist/serve/entries/init.js'
server relative imports are not implemented yet.
Please try an import relative to the file you are importing from.
```

Note the `./Users/...` — the leading slash was consumed. This affects **all eight**
`firebase/*` aliases, so the adapter's Turbopack path does not work as shipped.

**Suggested upstream fix:** emit `./`-prefixed paths relative to the project root
for `turbopack.resolveAlias` (webpack's `resolve.alias` is fine with absolute
paths, so only the Turbopack branch needs it).

**Workaround here:** `next.config.ts` post-processes `turbopack.resolveAlias` and
rewrites every absolute path under the project root to `./relative/form`.

### 3.3 Worker client `collection()` is missing `withConverter`

`dist/serve/worker/client/firestore-refs.js:53–59`:

```js
return {
    __kind: 'coll-ref',
    descriptor,
    port,
    id: lastSegment(path),
    path,
};
```

No `withConverter`, no `converter`. Its sibling
`dist/serve/worker/client/firestore-reference.js:4–18` (`createDocumentReference`)
**does** provide both, and the in-page implementation
`pyric/dist/firestore/refs.js:15,88` provides them for **both** kinds. So the
worker path is inconsistent with itself and with the in-page path.

Repro (standard Firebase, throws only under the sandbox in SharedWorker mode):

```ts
collection(db, 'narrations').withConverter(conv);
// TypeError: collection(...).withConverter is not a function
doc(db, 'narrations', id).withConverter(conv);  // fine
```

This only bites in **SharedWorker** mode, which is the mode a Next app is forced
onto (see §3.4). `entries/firestore.js:33` picks the implementation with
`const D = useWorker ? wc : ip`.

**Two further layers of the same gap** (found while scoping a workaround):

- `firestore-refs.js:131–148` — `query(source, ...)` returns
  `{__kind:'query', descriptor, port}` and **drops** any converter on the source.
- `snapshots.js:82` — `makeQuerySnapshot` calls `makeDocSnapshot(doc, port)`
  with **no reference argument**, so `ref.converter` is always `null` for query
  results. Compare `firestore-reads.js:24`, which *does* pass the ref for single
  document reads (`makeDocSnapshot(result, ref.port, ref)`).

So: **converters work for `getDoc`/`onSnapshot` on a document ref, and are
silently ignored for every query/collection read on the worker path.** A fix
needs all three points, not just the missing method.

**Upstream tracking issue:** [davideast/pyric#666](https://github.com/davideast/pyric/issues/666)

**Workaround here:** none in Pyric-owned code — the app maps snapshots
explicitly at its call sites (`toNarration`, `toUserProfile`) instead.

### 3.4 `--hosted` cannot work with `next dev`

Two independent blockers:

1. **Page-init stamp.** `dist/serve/entries/worker-runtime.js:183–187` throws at
   **module-evaluation time**:
   ```js
   if (!isServiceWorker) {
       const pagePayload = globalThis.__PYRIC_WORKER_INIT__;
       const pageHasNoPayload = typeof document !== 'undefined' && pagePayload === undefined;
       if (pageHasNoPayload)
           throw new Error('Missing Pyric page initialization. Reload the page through the sandbox server.');
   }
   ```
   That global is injected only by Pyric's own HTML transform (`stampHostedTarget`)
   or the Vite plugin's `transformIndexHtml`. **`withPyric` does no HTML
   transformation** — Next renders the document — so the stamp never exists.
2. **Hosted WebSocket must be same-origin.** Hosted attach dials
   `toPageOriginWsUrl(bridgeUrl, location, 'page-origin')`, and `'page-origin'`
   **discards the bridge port**. From a page on `:3000` that is
   `ws://localhost:3000/__pyric/sandbox`, and Next dev rewrites cannot proxy an
   `Upgrade: websocket`. The non-hosted path uses `'bridge-port'` routing, which
   keeps `:3473` and works.

The Next adapter landed (2026-07-24) well before hosted mode (2026-09-19) and was
never updated for it. `--hosted` is also implemented but undocumented in
`pyric --help`.

**Workaround here:** use SharedWorker mode (`--bridge --persist`) and stamp the
global ourselves — see §4.1.

### 3.5 Next 16 Turbopack externalizes `firebase-admin` as `firebase-admin-<hash>`, bypassing `@pyric/cli/register`

Next 16 lists `firebase-admin` and `firebase` in its built-in
`node_modules/next/dist/lib/server-external-packages.jsonc`. When Turbopack
compiles a server route handler (`/api/narrations`), it emits:

```js
// .next/dev/server/chunks/[turbopack]_runtime.js
require("firebase-admin-a14c8a5423a75469/auth")
```

alongside a symlink in `.next/dev/node_modules/firebase-admin-a14c8a5423a75469`.
Because `@pyric/cli/register`'s `mapFirebaseSpecifier()` only matches bare
`firebase-admin` or `firebase-admin/*`, it returns `null` for the hashed
specifier. Node loads the **real** `firebase-admin` SDK instead of `pyric-admin`,
which rejects Pyric's `sandbox-id-token-...` tokens with `401 Unauthorized`
(`"Decoding Firebase ID token failed"`).

**Suggested upstream fix:** in `@pyric/cli/src/register/specifier-map.ts`, match
`^firebase-admin(?:-[0-9a-f]{8,})?(\/.*)?$` and `^firebase(?:-[0-9a-f]{8,})?(\/.*)?$`.

**Workaround here:** `src/instrumentation.ts` registers a `node:module`
`registerHooks({ resolve })` hook on the Next Node.js server that strips the
`-<16hex>` suffix before delegating to `@pyric/cli/register`.

### 3.6 `pyric-admin/storage` single-bucket constraint & stub `getSignedUrl()`

Two behaviors in `pyric-admin/storage` differ from `@google-cloud/storage`:

1. `getStorage(app).bucket('my-bucket.firebasestorage.app')` throws:
   `pyric-admin/storage: the remote (browser) sandbox has a single bucket — bucket('...') cannot be isolated. Use bucket() (the default 'pyric-default' bucket) instead.`
   Calling `getStorage(app).bucket()` with **no argument** works in both real
   `firebase-admin` (which reads `storageBucket` from `initializeApp({...})`) and
   `pyric-admin` (which uses `'pyric-default'`).
2. `file.getSignedUrl(...)` returns a placeholder URI
   (`pyric-sandbox-storage://${path}?expires=...`) that the sandbox does not
   serve over HTTP. In `src/lib/narration-server.ts`, `signedReadUrl()` checks
   whether `url` starts with `http(s)://` and falls back to `file.download()`
   encoded as a `data:` URI when running against the sandbox.

### 3.7 Hardcoded 8 MiB Cloud Storage cap and 12/24 MiB WebSocket bridge limits sever long transfers

Firebase Cloud Storage is intended for multimedia and large assets (audio, video, documents). In `@pyric/cli` and `pyric-admin`, Cloud Storage operations over the bridge are wrapped in single base64-encoded JSON WebSocket frames governed by three tiered constants:

1. **Storage Op Limit (8 MiB)**: `MAX_STORAGE_OP_BYTES = 8 * 1024 * 1024` in `serve/worker/protocol/storage.ts` and `pyric-admin/src/storage/index.ts`. Any read or upload over 8 MiB throws `storagePayloadTooLarge`.
2. **Bridge Frame Limit (12 MiB)**: `MAX_BRIDGE_FRAME_BYTES = 12 * 1024 * 1024` in `bridge/protocol.ts`. Because an 8 MiB binary expands to ~10.67 MiB of base64 text, 12 MiB was chosen as the frame ceiling.
3. **Socket Backlog Limit (24 MiB)**: In `bridge/server/socket-message.ts`, Pyric checked:
   ```ts
   const exceedsBacklog = socket.bufferedAmount + Buffer.byteLength(payload) > 24 * 1024 * 1024;
   if (exceedsBacklog) {
       socket.close(1013, 'Client output backlog exceeds 24 MiB; reconnect to resume.');
       return;
   }
   ```
   Note that this check hardcoded `24 * 1024 * 1024` instead of referencing `MAX_QUEUED_OPERATION_BYTES`.

**The Failure Mode:**
When audio files exceed ~4–5 minutes (~14–20+ MiB raw WAV audio), base64 encoding expands them beyond 24 MiB (e.g. a 6m47s audio track is 19.55 MiB raw audio, expanding to 26.07 MiB base64).
When pushed to the WebSocket, `socket-message.ts` trips the 24 MiB check and executes `socket.close(1013)`.
Instead of gracefully refusing the single operation, closing the WebSocket aborts the entire bridge connection. This causes all in-flight and future operations across the process to fail with:
`Error [SandboxError]: remote sandbox connection closed (serve stopped or connection lost)`
and leaves Firestore documents stuck in `status: 'streaming'`, disappearing from the UI on reload with "That narration isn't available."

**Suggested Upstream Fix:**
- Replace the magic number in `socket-message.ts` with `MAX_QUEUED_OPERATION_BYTES` (and make the budget configurable via `pyric.json`).
- Gracefully refuse oversized operations via `refuseBridgeRequest(frame)` rather than destroying the underlying transport socket.
- Support HTTP chunked streaming for Cloud Storage transfers rather than wrapping whole binaries in single JSON WebSocket messages.

**Upstream tracking issue:** [davideast/pyric#668](https://github.com/davideast/pyric/issues/668)

### 3.8 Replay has no initial-state fixture support

`pyric verify [fixture]` replays captured session events against candidate rules starting from an empty sandbox:
```ts
// node_modules/@pyric/cli/dist/verify/index.js:72
const { divergences } = replayFirestore(fixture.events, rules, {}, firestore.state.documents);

// node_modules/pyric/dist/sandbox/replay/index.js:68
const sandbox = initializeSandbox(); // starts from an empty DB
```
Because the `pyric.verify.fixture.v1` schema records only the *final* snapshot in `services.firestore.state.documents` and no initial baseline state, any data seeded prior to the session (such as Firestore allowlist documents added directly to SQLite or created via admin tools before starting the dev server) is missing during replay. On replay, `exists(/databases/$(database)/documents/allowlist/...)` evaluates to false, causing subsequent writes that depend on prior state to diverge:
```
✗ last-session - firestore: 3 failure(s)
  state-drift: allowlist/alice@example.test: {...} -> undefined
  state-drift: allowlist/bob@example.test: {...} -> undefined
  state-drift: users/provider-db94bc52-...: {...} -> undefined
```

**Workaround:** Ensure the capture session begins from a fresh state and records admin writes (e.g. `studio:allowlist add ...`) within the captured session so they replay as `write` events with `detail.admin: true`.

### 3.9 Derived Rules Test API cases omit exists()/get() functionMocks

`pyric verify cases [fixture]` derives test cases for the Firebase Rules Test API (`firebaserules.googleapis.com/v1/projects/{project}:test`) from captured sessions. However, the generator does not synthesize `functionMocks` for external calls like `exists()` or `get()` across document collections (e.g. `exists(/databases/$(database)/documents/allowlist/$(email))`):
```json
{
  "expectation": "ALLOW",
  "method": "get",
  "path": "allowlist/alice@example.test",
  "auth": { "uid": "...", "token": { "email": "alice@example.test", "email_verified": true } }
}
```
When submitted to Google's hosted Rules Test API without `functionMocks`, rules that perform cross-document `exists()` checks evaluate against an empty mock environment and fail with `PERMISSION_DENIED`.

**Workaround:** Author dedicated hosted verification suites (like `scripts/verify-rules-hosted.mjs`) that explicitly attach `{ function: 'exists', args: [{ anyValue: {} }], result: { value: true } }` function mocks.

### 3.10 Hosted verify accepts only service-account credentials

Running `pyric verify --engine rules-test-api` or `--engine both` expects a service account JSON key:
```bash
$ npx pyric verify .pyric/last-session.json --engine both --project mdmedia-dev
pyric verify: pyric: Rules Test API verification requires FIREBASE_SA_BASE64, GOOGLE_APPLICATION_CREDENTIALS, or Application Default Credentials from `gcloud auth application-default login`.
```
When pointed at an authorized user credential (e.g. from Firebase CLI or gcloud user OAuth), Pyric throws:
```
pyric verify: fromServiceAccount: input is missing required fields (client_email, private_key, project_id)
```
The Firebase Rules Test API is a standard Google Cloud REST API that accepts standard OAuth bearer tokens with project test scope; requiring a service account key is unnecessary and blocks developers authenticated via `firebase login`.

**Workaround:** Call the Rules Test API directly using the Firebase CLI OAuth access token via `scripts/verify-rules-hosted.mjs`.

### 3.11 SEM-4 false positives on resolved Standard Library functions

Running `pyric firestore rules validate` on resolved output generated by `pyric firestore rules resolve` flags top-level standard library functions (e.g. `immutableFields`, `isOwner`) with false-positive semantic errors:
```json
{
  "code": "SEM-4",
  "severity": "high",
  "path": "/playlists/{playlistId}",
  "operation": "update",
  "message": "Rule at /playlists/{playlistId} calls undefined function 'immutableFields'"
}
```
When tested with Google's hosted Rules Test API (`firebaserules.googleapis.com`), the same generated rules compile cleanly with zero issues (`issues: []`), proving the file is fully valid and that `pyric firestore rules validate`'s AST scope resolver has a bug resolving top-level functions defined outside the match block.

---

## 4. Workarounds in this repo

Everything Pyric-specific lives in files nobody else owns:
`next.config.ts`, `pyric.json`, and `src/pyric-bootstrap/` +
`src/instrumentation-client.ts`. **No application module references Pyric.**

### 4.1 Page-init stamp — fixes "Missing Pyric page initialization"

`src/pyric-bootstrap/page-init.ts` sets `globalThis.__PYRIC_WORKER_INIT__` to the
SharedWorker payload `{hosted:false, projectKey:null, bridgeUrl:null}`.

Two things are load-bearing:

- **`page-init.ts` has zero imports.** Anything it imported could be evaluated
  before it.
- **Import order in `src/pyric-bootstrap/index.ts`.** ESM evaluates dependencies
  depth-first in source order, so `import './page-init'` must come *before*
  `import 'pyric-sdk-init'`. Swapping them reintroduces the crash.

It is wired in through **`src/instrumentation-client.ts`**, which Next runs before
any application frontend code. That avoids touching `src/app/layout.tsx`.

### 4.2 Google sign-in and the runtime chip — the `pyric-sdk-init` alias

`dist/serve/entries/init.js` is what calls `installServeAuthResolver()` (line 63),
`mountAuthHelperDialog()` (67) and `installPyricRuntimeChip()` (79). `withPyric`
aliases only the eight `firebase/*` service entries — **the init entry is not
among them**, so in a stock Next app:

- `signInWithPopup(new GoogleAuthProvider())` rejects with
  `pyric sandbox provider helper is not initialized; load /__pyric/sdk/init.js first`
- the runtime chip never mounts (the docs claim `withPyric` propagates the chip
  automatically; it only sets the env var, nothing calls the installer)

> [!IMPORTANT]
> Adding `<script src="/__pyric/sdk/init.js">` does **not** work. That is a
> separate esbuild bundle with its own module instances, so the resolver slot in
> the *Next-bundled* copy of `auth-helper-runtime.js` stays null. The init entry
> has to be in the **same Turbopack graph** as the aliased `firebase/auth`.

So `next.config.ts` adds a `pyric-sdk-init` alias pointing at
`.../dist/serve/entries/init.js`, and `src/pyric-bootstrap/index.ts` imports it.
One alias fixes both sign-in and the chip.

The path is derived from the `firebase/auth` alias `withPyric` already emitted,
rather than `require.resolve`, because `@pyric/cli` exports neither a root entry
nor `./package.json`. Verified safe: `init.js` imports no `firebase/*`, so there
is no alias cycle.

For `next build`, the alias falls back to `src/pyric-bootstrap/init-noop.ts` (an
empty module) so the specifier stays resolvable and production ships no Pyric code.

### 4.3 Expected warnings

- `ExperimentalWarning: SQLite is an experimental feature` — expected.
- `no database.rules.json found — client RTDB reads/writes default to DENY` —
  expected, this app does not use RTDB.
- `no browser tab connected after 30s — starting your command anyway` — expected
  in SharedWorker mode.
- Next may warn that a webpack config is present while using Turbopack;
  `withPyric` always sets both. The Turbopack aliases are the ones in effect.

### 4.4 Uncapping Pyric Storage & Bridge limits (`scripts/patch-pyric-bridge-port.js`)

To allow narrations of any length to save and play in the studio, [`scripts/patch-pyric-bridge-port.js`](file:///Users/deast/repos/davideast/tts-flash/studio/scripts/patch-pyric-bridge-port.js) (hooked to `postinstall` in `package.json`) automatically patches:
1. `bridge-url.js` to preserve the bridge port `3473` under Next.js port `3000`.
2. `serve/worker/protocol/storage.js` to raise `MAX_STORAGE_OP_BYTES` from 8 MiB to **512 MiB**.
3. `bridge/protocol.js` to raise `MAX_BRIDGE_FRAME_BYTES` and `MAX_QUEUED_OPERATION_BYTES` from 12/24 MiB to **768 MiB**.
4. `pyric-admin/dist/storage/index.js` to raise `MAX_REMOTE_STORAGE_OP_BYTES` from 8 MiB to **512 MiB**.
5. `bridge/server/socket-message.js` to raise the socket output backlog cap from 24 MiB to **768 MiB**.

---

## 5. AI Logic

The assist model (`gemini-3.5-flash-lite`, via `getAI()` / `getGenerativeModel()`)
currently runs against **Pyric's sandbox mirror**, not real Google endpoints.

**Live client-side pass-through is not achievable in this setup.** `getClientAliases()`
takes no AI mode and always maps `firebase/ai → entries/ai.js`. `PYRIC_AI_MODE=production`
is honoured only by the Node loader hook and by Pyric's own served import map —
**neither governs Turbopack** — so setting it would flip server-side AI to real
Google while the browser kept using the mirror. Bringing the init entry into the
graph (§4.2) does not change this; the aliases are independent of it. The startup
banner says as much: `ai  no engine configured; the served page's getAI() picks one`.

The remaining option is Pyric's Gemini **broker** engine, selected by setting
`globalThis.__PYRIC_AI_ENGINE__ = {kind:'gemini', apiKey}`. `page-init.ts` supports
this behind `NEXT_PUBLIC_PYRIC_GEMINI_API_KEY`, which is **commented out in
`.env.local` by default**:

> [!CAUTION]
> In SharedWorker mode the broker executes **inside the browser worker**, so the
> key must ride in the engine wire and is therefore embedded in the client bundle
> and visible in devtools. `/__pyric/ai-proxy` cannot hide it either — it forwards
> the browser's `authorization` header and never injects a server-side key. Only
> enable this locally, never in a shared or deployed environment.

Also note Pyric's broker **rewrites the model**: `gemini-3.5-flash-lite` →
`gemini-flash-lite-latest` ("experimental alias").

`PYRIC_AI_MODE=production` is deliberately **not** set in the `dev` script. It
requires a real Firebase `apiKey`/`projectId`, and `.env.local` holds placeholders,
so it would break server-side AI without fixing the client.

**Unaffected:** narration/TTS calls the real Gemini API server-side through
`mdmedia` using `process.env.GEMINI_API_KEY` directly. That path never touches
Firebase AI Logic, so none of the above applies to it. The real key is in
`.env.local`.

---

## 6. Status

| Item | State |
|---|---|
| Sandbox host + rules deployment | ✅ working |
| `/__pyric/*` rewrite through the Next port | ✅ working |
| SharedWorker sandbox + MCP bridge WebSocket | ✅ connected |
| Page-init stamp (§3.4 blocker 1) | ✅ worked around |
| Google `signInWithPopup` | ✅ working — picker opens, sign-in completes |
| Runtime chip | ✅ mounts ("Open pyric", bottom-right) |
| `collection().withConverter()` | ⚠️ upstream bug §3.3 — handled in app code |
| Client-side AI Logic pass-through | ❌ not possible — see §5 |
| `--hosted` mode | ❌ not usable with `next dev` — see §3.4 |
