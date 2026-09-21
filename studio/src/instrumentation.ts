/**
 * Server instrumentation.
 *
 * Next runs `register()` once per server runtime, before any route or page
 * module is evaluated. That ordering is the whole reason this file exists:
 * the module-resolution hook it installs has to be in place before the first
 * `firebase-admin` import is resolved.
 *
 * Everything here is inert unless `pyric sandbox` is driving the process.
 */

export async function register(): Promise<void> {
  // `PYRIC_SANDBOX` is set only by `pyric sandbox`. A plain `next dev`, a
  // `next build`, and every deployed server skip this entirely.
  if (!process.env.PYRIC_SANDBOX) return;
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Next compiles `instrumentation.ts` for the Edge runtime as well as Node,
  // and any statically visible `import('node:module')` fails that compilation
  // outright ("A Node.js module is loaded … not supported in the Edge
  // Runtime") even though the guard above means it never executes there.
  // `/* turbopackIgnore */` does not suppress it — the check runs before the
  // hint is honoured. Building the import inside `new Function` puts the
  // specifier beyond the bundler's static analysis entirely.
  const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string,
  ) => Promise<unknown>;

  /**
   * `module.registerHooks` (Node >= 22.15) is the synchronous resolution-hook
   * API. The installed `@types/node` predates it, so the shape is declared
   * here rather than reached for through `any` at each call site.
   */
  type ResolveContext = { parentURL?: string | undefined };
  type ResolveResult = { url: string; shortCircuit?: boolean };
  type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;
  type ModuleWithHooks = {
    registerHooks?: (hooks: {
      resolve: (
        specifier: string,
        context: ResolveContext,
        nextResolve: NextResolve,
      ) => ResolveResult;
    }) => void;
  };

  const { registerHooks } = (await dynamicImport('node:module')) as ModuleWithHooks;
  if (typeof registerHooks !== 'function') return;

  /**
   * Turbopack renames externalised packages.
   *
   * `firebase-admin` is on Next's built-in `serverExternalPackages` list, so
   * route handlers do not bundle it — they require it at runtime, which is
   * exactly what Pyric's `@pyric/cli/register` loader hook is designed to
   * intercept (swapping `firebase-admin/*` for its `pyric-admin/*` mirror).
   *
   * Under Turbopack the specifier that actually reaches Node is not the one
   * the source wrote. It carries a content-hash suffix on the *package name*:
   *
   *     firebase-admin-a14c8a5423a75469/auth
   *     firebase-admin-a14c8a5423a75469/app
   *       ← .next/dev/server/chunks/[turbopack]_runtime.js
   *
   * Pyric's matcher only recognises the bare `firebase-admin` / `firebase`
   * roots, so it passes those straight through and the route handler ends up
   * with the *real* Admin SDK. `verifyIdToken` then rejects every sandbox
   * token ("Decoding Firebase ID token failed…") and every authenticated API
   * call answers 401.
   *
   * This hook strips the suffix and hands the clean specifier to the rest of
   * the chain, where Pyric's own hook — registered earlier, so it sits behind
   * ours — does the actual mapping and the ESM-only `require` dance.
   *
   * Delete this once Pyric's matcher tolerates Turbopack's hashed names.
   */
  const HASHED_EXTERNAL = /^(firebase-admin|firebase)-[0-9a-f]{8,}(\/.*)?$/;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const match = HASHED_EXTERNAL.exec(specifier);
      if (!match) return nextResolve(specifier, context);
      return nextResolve(`${match[1]}${match[2] ?? ''}`, context);
    },
  });
}
