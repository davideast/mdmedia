import {defineCommand} from 'citty';
import {readFile} from 'node:fs/promises';
import {StudioProjectsClient, type ProjectImport} from '../projects/index.js';
const connection = {
  studio: {type: 'string' as const, description: 'Studio origin, e.g. http://127.0.0.1:3101', required: true as const},
  'token-file': {type: 'string' as const, description: 'File containing a Firebase ID token (or set MDMEDIA_STUDIO_TOKEN)'},
};
async function client(args: {studio: string; 'token-file'?: string}) {
  const token = args['token-file'] ? await readFile(args['token-file'], 'utf8') : process.env.MDMEDIA_STUDIO_TOKEN;
  if (!token?.trim()) throw new Error('Provide --token-file or MDMEDIA_STUDIO_TOKEN. Tokens are never printed.');
  return new StudioProjectsClient(args.studio, token);
}
export const projectCommand = defineCommand({
  meta: {name: 'project', description: 'Import and inspect saved Studio projects without generating media'},
  subCommands: {
    import: defineCommand({
      args: {...connection, input: {type: 'string', required: true, description: 'Version 1 project manifest JSON'}},
      async run({args}) {
        const raw = await readFile(args.input, 'utf8');
        if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Project manifest exceeds 128 KB.');
        const result = await (await client(args)).importProject(JSON.parse(raw) as ProjectImport);
        console.log(JSON.stringify({...result, url: new URL(result.href, args.studio).href}));
      },
    }),
    get: defineCommand({args: {...connection, id: {type: 'string', required: true}}, async run({args}) {
      console.log(JSON.stringify(await (await client(args)).getProject(args.id)));
    }}),
    list: defineCommand({args: connection, async run({args}) {
      console.log(JSON.stringify(await (await client(args)).listProjects()));
    }}),
  },
});
