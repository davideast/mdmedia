import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.PYRIC_SANDBOX_FORCE === '1' ? undefined : 'standalone',
  // A staged hosted build must never replace the files used by the running server.
  distDir: process.env.MDMEDIA_DIST_DIR ?? (process.env.PYRIC_SANDBOX_FORCE === '1' ? '.next-hosted' : '.next'),
  allowedDevOrigins: (process.env.MDMEDIA_ALLOWED_DEV_ORIGINS ?? '')
    .split(',').map((host) => host.trim()).filter(Boolean),
  async redirects() {
    return [
      {
        source: "/favicon.ico",
        destination: "/icon.svg",
        permanent: false,
      },
    ];
  },
};

/**
 * ---------------------------------------------------------------------------
 * Why this file does not simply `import { withPyric } from "@pyric/cli/next"`
 * ---------------------------------------------------------------------------
 * Next.js 16 compiles `next.config.ts` to **CommonJS** (verified: `require`,
 * `module` and `__dirname` are all defined inside this file at load time), so
 * that import statement becomes `require("@pyric/cli/next")`.
 *
 * `@pyric/cli`'s package exports declare `./next` with only `types` and
 * `import` conditions and no `require` condition:
 *
 *     "./next": {
 *       "types": "./dist/next/index.d.ts",
 *       "import": "./dist/next/index.js"
 *     }
 *
 * so the CJS require fails hard with:
 *
 *     Error: Package subpath './next' is not defined by "exports" in
 *     .../node_modules/@pyric/cli/package.json
 *     ERR_PACKAGE_PATH_NOT_EXPORTED
 *
 * That makes the documented `withPyric` usage unusable from `next.config.ts`
 * as shipped. The upstream fix is to add a `require` condition (or ship a CJS
 * build) for `./next`.
 *
 * Workaround: export an **async** config function (Next supports this) and
 * pull the adapter in with a dynamic `import()` of an absolute `file://` URL.
 * A file URL bypasses the package `exports` map entirely, and dynamic import
 * works from CommonJS.
 *
 * Remove all of this and go back to a plain top-level import once `./next`
 * gains a `require` condition.
 */

/** Locate `node_modules/@pyric/cli` by walking up from this project. */
function findPyricCliDir(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, "node_modules", "@pyric", "cli");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export default async function buildConfig(): Promise<NextConfig> {
  // Pyric explicitly supports a compiled local sandbox with PYRIC_SANDBOX_FORCE=1.
  // A regular production build still uses the real Firebase SDK.
  const usesRealFirebase =
    process.env.NODE_ENV === "production" && process.env.PYRIC_SANDBOX_FORCE !== "1";
  const cliDir = usesRealFirebase ? null : findPyricCliDir();

  if (!cliDir) {
    // Production (or Pyric not installed): keep the `pyric-sdk-init` specifier
    // used by src/pyric-bootstrap/index.ts resolvable by pointing it at a local
    // empty module, so the build succeeds and ships no Pyric code.
    const noop = "./src/pyric-bootstrap/init-noop.ts";
    const noopAbsolute = path.join(__dirname, "src", "pyric-bootstrap", "init-noop.ts");
    return {
      ...nextConfig,
      turbopack: {
        ...(nextConfig.turbopack ?? {}),
        root: __dirname,
        resolveAlias: { "pyric-sdk-init": noop },
      },
      webpack: (webpackConfig: any, options: any) => {
        if (!options.isServer) {
          webpackConfig.resolve = webpackConfig.resolve ?? {};
          webpackConfig.resolve.alias = {
            ...(webpackConfig.resolve.alias ?? {}),
            "pyric-sdk-init": noopAbsolute,
          };
        }
        return webpackConfig;
      },
    } as NextConfig;
  }

  const adapterUrl = pathToFileURL(path.join(cliDir, "dist", "next", "index.js")).href;

  /**
   * `new Function` keeps this a real dynamic `import()` at runtime.
   *
   * Next compiles this file into `next.config.compiled.js` (CommonJS) and
   * downlevels a literal `await import(x)` into `require(x)` — which then fails
   * with `Cannot find module 'file:///.../dist/next/index.js'`, because
   * `require` does not accept URLs. Hiding the import inside a function body
   * built at runtime puts it beyond the transpiler's reach.
   */
  const dynamicImport = new Function("specifier", "return import(specifier);") as (
    specifier: string,
  ) => Promise<any>;

  const { withPyric } = (await dynamicImport(adapterUrl)) as {
    withPyric: (config: NextConfig, options?: Record<string, unknown>) => any;
  };

  /**
   * `withPyric` rewrites the eight `firebase/*` browser specifiers to Pyric's
   * sandbox entries, adds the `/__pyric/:path*` dev rewrite, and marks
   * `firebase` / `firebase-admin` as server-external so the Node loader hook
   * installed by `pyric sandbox` can substitute them server-side.
   */
  const sandboxUrl = (process.env.PYRIC_SANDBOX ?? "remote:http://127.0.0.1:3473")
    .replace(/^remote:/, "")
    .replace(/\/$/, "");
  const bridgeUrl = new URL("/__pyric/sandbox", sandboxUrl);
  bridgeUrl.protocol = bridgeUrl.protocol === "https:" ? "wss:" : "ws:";

  const config = withPyric({
    ...nextConfig,
    env: {
      ...nextConfig.env,
      NEXT_PUBLIC_PYRIC_BRIDGE_PORT: process.env.NEXT_PUBLIC_PYRIC_BRIDGE_PORT ?? '',
      NEXT_PUBLIC_PYRIC_PROJECT_KEY: process.env.PYRIC_PROJECT_KEY ?? __dirname,
      NEXT_PUBLIC_PYRIC_BRIDGE_URL: bridgeUrl.toString(),
    },
  }, {
    url: sandboxUrl,
    // 'collapsed' — the floating Pyric runtime chip, mounted by the init entry
    // aliased below. See src/pyric-bootstrap/.
    runtimeChip: true,
  });

  /**
   * Gap workaround: pull Pyric's page-init entry into the Next module graph.
   *
   * `@pyric/cli/dist/serve/entries/init.js` is what calls
   * `installServeAuthResolver()` (making `signInWithPopup(new
   * GoogleAuthProvider())` resolve to the sandbox account picker) and
   * `installPyricRuntimeChip()`. Pyric normally serves it as a separate esbuild
   * bundle at `/__pyric/sdk/init.js`, but loading it via a <script> tag gives
   * it its own module instances, so the resolver slot inside the
   * *Next-bundled* copy of `auth-helper-runtime.js` would stay null.
   *
   * Aliasing it means Turbopack resolves it through the same relative imports
   * as the aliased `firebase/auth`, so both share one module instance and the
   * resolver is actually visible to `signInWithPopup`.
   */
  const initEntry = path.join(cliDir, "dist", "serve", "entries", "init.js");

  config.turbopack = config.turbopack ?? {};
  config.turbopack.resolveAlias = {
    ...(config.turbopack.resolveAlias ?? {}),
    "pyric-sdk-init": initEntry,
  };

  /**
   * Turbopack cannot use the absolute filesystem paths that `withPyric` puts in
   * `turbopack.resolveAlias`. It reads a value beginning with `/` as a
   * *server-relative URL*, not a path, and fails with:
   *
   *     Module not found: Can't resolve
   *     './Users/deast/.../dist/serve/entries/init.js'
   *     server relative imports are not implemented yet.
   *
   * Note the tell-tale `./Users/...` — the leading slash was consumed. This
   * affects all eight `firebase/*` aliases the adapter emits, so the Next
   * adapter's Turbopack path does not work as shipped in Next 16.
   *
   * Fix: rewrite every absolute path under the project root to the
   * `./`-prefixed project-relative form Turbopack expects. Paths outside the
   * project root are left alone (nothing sensible to rewrite them to).
   */
  const toProjectRelative = (value: string): string => {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(__dirname, value);
    if (relative.startsWith("..")) return value;
    return `./${relative.split(path.sep).join("/")}`;
  };

  config.turbopack.resolveAlias = Object.fromEntries(
    Object.entries(config.turbopack.resolveAlias as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === "string" ? toProjectRelative(value) : value,
    ]),
  );

  // Mirror the alias into webpack too, for `next dev --webpack`.
  const previousWebpack = config.webpack;
  config.webpack = (webpackConfig: any, options: any) => {
    const result = previousWebpack ? previousWebpack(webpackConfig, options) : webpackConfig;
    if (!options.isServer) {
      result.resolve = result.resolve ?? {};
      result.resolve.alias = { ...(result.resolve.alias ?? {}), "pyric-sdk-init": initEntry };
    }
    return result;
  };

  // Silences the "inferred workspace root" warning: there is a bun.lock in the
  // repo root and a package-lock.json here, so Turbopack guesses wrong.
  config.turbopack.root = __dirname;

  return config;
}
