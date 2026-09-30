/**
 * Pyric page-initialization stamp.
 *
 * IMPORTANT: this module must have **zero imports**. Its whole job is to set a
 * global before any Pyric module is evaluated, and ESM guarantees that only if
 * nothing else can be pulled in ahead of it.
 *
 * Why it exists: `@pyric/cli/dist/serve/entries/worker-runtime.js` has a
 * top-level (module-evaluation time) throw:
 *
 *     if (!isServiceWorker) {
 *       const pagePayload = globalThis.__PYRIC_WORKER_INIT__;
 *       const pageHasNoPayload = typeof document !== 'undefined' && pagePayload === undefined;
 *       if (pageHasNoPayload)
 *         throw new Error('Missing Pyric page initialization. Reload the page through the sandbox server.');
 *     }
 *
 * Every aliased `firebase/*` entry imports that module, so the stamp has to be
 * in place before the first `firebase/auth` / `firebase/firestore` import
 * evaluates. Pyric's own static server injects it with an inline
 * `<script data-pyric-worker-init>` (see `serve/runtime/hosted-target.ts`), and
 * the Vite plugin does it in `transformIndexHtml` — but `withPyric` performs no
 * HTML transformation, because the Next dev server renders the document. This
 * file is the Next-side equivalent.
 *
 * Payload shape (`serve/init-payload.ts`):
 *   { hosted: boolean, projectKey: string | null, bridgeUrl: string | null,
 *     persistenceUnhealthy?: boolean }
 *
 * Next supplies the local project identity through next.config.ts. The
 * postinstall Pyric bridge patch preserves the bridge port for the hosted
 * WebSocket, which Next dev cannot proxy through its HTTP rewrites.
 */

declare global {
  // eslint-disable-next-line no-var
  var __PYRIC_WORKER_INIT__:
    | { hosted: boolean; projectKey: string | null; bridgeUrl: string | null; persistenceUnhealthy?: boolean }
    | undefined;
  // eslint-disable-next-line no-var
  var __PYRIC_AI_ENGINE__: { kind: string; apiKey?: string } | undefined;
}

const projectKey = process.env.NEXT_PUBLIC_PYRIC_PROJECT_KEY;

if (typeof document !== "undefined" && projectKey && globalThis.__PYRIC_WORKER_INIT__ === undefined) {
  globalThis.__PYRIC_WORKER_INIT__ = {
    hosted: true,
    projectKey,
    bridgeUrl: "ws://localhost:3473/__pyric/sandbox",
  };
}

/**
 * Optional: select Pyric's Gemini broker engine instead of its deterministic
 * mirror, so `getAI()` / `getGenerativeModel()` calls reach real Google
 * endpoints. `entries/ai.js` reads this wire lazily at `getAI()` call time, so
 * setting it here is early enough.
 *
 * A NEXT_PUBLIC_ key is visible to the browser. This remains opt-in and does
 * not read the server-side GEMINI_API_KEY. Leave it unset for the local mirror.
 */
const geminiKey = process.env.NEXT_PUBLIC_PYRIC_GEMINI_API_KEY;

if (typeof document !== "undefined" && geminiKey && globalThis.__PYRIC_AI_ENGINE__ === undefined) {
  globalThis.__PYRIC_AI_ENGINE__ = { kind: "gemini", apiKey: geminiKey };
}

export {};
