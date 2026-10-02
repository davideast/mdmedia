import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function installAntigravityPlugin(baseDir: string = os.homedir()): string {
  const pluginDir = path.join(baseDir, '.gemini/config/plugins/mdmedia_narrator');
  const sidecarDir = path.join(pluginDir, 'sidecars/narrator');
  const assetsDir = path.join(pluginDir, 'assets');

  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // Locate the installed mdmedia package root dynamically
  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), '../..');

  // 1. plugin.json
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(
      {
        name: 'mdmedia_narrator',
        description: 'Narrate agent responses from Antigravity conversations in real time using Gemini Flash 3.1 TTS and mdmedia.',
        logo: 'assets/logo.svg',
      },
      null,
      2
    )
  );

  // 2. assets/logo.svg
  fs.writeFileSync(
    path.join(assetsDir, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>\n'
  );

  // 3. sidecar.json
  fs.writeFileSync(
    path.join(sidecarDir, 'sidecar.json'),
    JSON.stringify(
      {
        command: 'node',
        args: ['main.mjs'],
        restart_policy: 'always',
        has_web_ui: true,
        ui_config: {
          display_name: 'mdmedia Narrator',
          views: [
            {
              path: '/',
              entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
              title: 'Narrator',
            },
          ],
        },
      },
      null,
      2
    )
  );

  // 4. sidecars/narrator/main.mjs
  fs.writeFileSync(
    path.join(sidecarDir, 'main.mjs'),
    `import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { startNarratorSidecarServer } from 'mdmedia';\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nstartNarratorSidecarServer(__dirname);\n`
  );

  // 5. Portable package.json pointing to the installed mdmedia package
  fs.writeFileSync(
    path.join(sidecarDir, 'package.json'),
    JSON.stringify(
      {
        name: 'mdmedia-narrator-sidecar',
        type: 'module',
        private: true,
        dependencies: {
          mdmedia: `file:${packageRoot}`,
        },
      },
      null,
      2
    )
  );

  return pluginDir;
}

