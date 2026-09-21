/**
 * Next.js client instrumentation hook.
 *
 * Next runs `src/instrumentation-client.ts` before any application frontend
 * code executes, which is exactly the ordering Pyric's browser runtime needs:
 * the `__PYRIC_WORKER_INIT__` stamp must exist before the first aliased
 * `firebase/*` import is evaluated.
 *
 * Using this hook (rather than editing `src/app/layout.tsx`) keeps all Pyric
 * wiring out of the application source — `src/lib/firebase.ts` and every
 * component stay plain, standard Firebase code with no sandbox branches.
 */
import "./pyric-bootstrap";
