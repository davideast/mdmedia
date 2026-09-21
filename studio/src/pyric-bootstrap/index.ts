/**
 * Pyric browser bootstrap.
 *
 * Import order below is LOAD-BEARING. ESM evaluates a module's dependencies
 * depth-first in source order, so `./page-init` (which has no imports of its
 * own) fully evaluates and sets `globalThis.__PYRIC_WORKER_INIT__` before
 * `pyric-sdk-init` — and the `worker-runtime.js` it pulls in — is evaluated.
 * Swapping these two lines reintroduces the
 * "Missing Pyric page initialization" crash.
 */
import "./page-init";

/**
 * `pyric-sdk-init` is aliased in next.config.ts to
 * `@pyric/cli/dist/serve/entries/init.js`. Evaluating it:
 *
 *  - calls `installServeAuthResolver(resolver)`, which is what makes
 *    `signInWithPopup(new GoogleAuthProvider())` open the sandbox account
 *    picker instead of rejecting with
 *    "pyric sandbox provider helper is not initialized; load
 *     /__pyric/sdk/init.js first";
 *  - calls `mountAuthHelperDialog(helper)` to put that picker in the DOM;
 *  - calls `installPyricRuntimeChip(...)` to mount the floating runtime chip.
 *
 * None of this happens in a stock Next app: `withPyric` aliases only the eight
 * `firebase/*` service entries, and the init entry is not among them.
 */
import "pyric-sdk-init";
