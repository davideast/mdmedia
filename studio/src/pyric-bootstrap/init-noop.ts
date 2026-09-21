/**
 * Production stand-in for Pyric's init entry.
 *
 * `withPyric` is an identity passthrough when NODE_ENV === 'production', so no
 * `firebase/*` aliases exist during `next build` and there is nothing to derive
 * the real init entry path from. next.config.ts points the `pyric-sdk-init`
 * alias here in that case, which keeps the import in
 * `src/pyric-bootstrap/index.ts` resolvable and leaves the production bundle
 * free of any Pyric code.
 */
export {};
