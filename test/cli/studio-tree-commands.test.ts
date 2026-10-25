import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from 'citty';
import { studioCommand } from '../../src/cli/studio-command.js';
import { StudioApiError, StudioClient } from '../../src/remote/client.js';
import * as compileTreeRoute from '../../studio/src/app/api/v1/trees/[id]/compile/route';
import * as treeNodeRoute from '../../studio/src/app/api/v1/trees/[id]/nodes/[nodeId]/route';
import * as treeOpsRoute from '../../studio/src/app/api/v1/trees/[id]/ops/route';
import * as singleTreeRoute from '../../studio/src/app/api/v1/trees/[id]/route';
import * as treesRoute from '../../studio/src/app/api/v1/trees/route';
import { InMemoryTreeStore } from '../../studio/src/lib/tree-fakes';
import type { NarrationStarterPort } from '../../studio/src/lib/tree-types';

const KEY = 'mdm_ABCDEFGHIJKLMNOP_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ORIGIN = 'http://localhost:3000';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdmedia-tree-cli-'));
  tempDirs.push(dir);
  return dir;
}

function createTreeApiRouter(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (pathname === '/api/v1/trees') {
      if (method === 'GET') return treesRoute.GET(req);
      if (method === 'POST') return treesRoute.POST(req);
    }

    const compileMatch = pathname.match(/^\/api\/v1\/trees\/([^/]+)\/compile$/);
    if (compileMatch && method === 'POST') {
      return compileTreeRoute.POST(req, { params: Promise.resolve({ id: compileMatch[1]! }) });
    }

    const opsMatch = pathname.match(/^\/api\/v1\/trees\/([^/]+)\/ops$/);
    if (opsMatch && method === 'POST') {
      return treeOpsRoute.POST(req, { params: Promise.resolve({ id: opsMatch[1]! }) });
    }

    const nodeMatch = pathname.match(/^\/api\/v1\/trees\/([^/]+)\/nodes\/([^/]+)$/);
    if (nodeMatch) {
      const ctx = { params: Promise.resolve({ id: nodeMatch[1]!, nodeId: nodeMatch[2]! }) };
      if (method === 'GET') return treeNodeRoute.GET(req, ctx);
      if (method === 'PUT') return treeNodeRoute.PUT(req, ctx);
    }

    const singleMatch = pathname.match(/^\/api\/v1\/trees\/([^/]+)$/);
    if (singleMatch) {
      const ctx = { params: Promise.resolve({ id: singleMatch[1]! }) };
      if (method === 'GET') return singleTreeRoute.GET(req, ctx);
      if (method === 'PATCH') return singleTreeRoute.PATCH(req, ctx);
      if (method === 'DELETE') return singleTreeRoute.DELETE(req, ctx);
    }

    return Response.json(
      { error: { code: 'not_found', message: `No route for ${method} ${pathname}` } },
      { status: 404 },
    );
  }) as typeof fetch;
}

describe('Next.js /api/v1/trees route handlers & StudioClient', () => {
  let store: InMemoryTreeStore;
  let startedNarrations: Array<{ uid: string; title: string; voice?: string; narrationId: string }>;
  let client: StudioClient;

  beforeEach(() => {
    startedNarrations = [];
    let narCounter = 0;
    const narrationStarter: NarrationStarterPort = {
      async start(uid, input) {
        narCounter += 1;
        const narrationId = `nar_${narCounter}`;
        startedNarrations.push({ uid, title: input.title, voice: input.voice, narrationId });
        return { narrationId };
      },
    };
    store = new InMemoryTreeStore('user_test', narrationStarter);
    treesRoute.setTreeStoreForTesting(store, 'user_test');
    client = new StudioClient(ORIGIN, KEY, createTreeApiRouter());
  });

  afterEach(() => {
    treesRoute.setTreeStoreForTesting(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces authentication and trees:manage scope on route handlers', async () => {
    const unauthRes = await treesRoute.GET(new Request(`${ORIGIN}/api/v1/trees`));
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as { error: { code: string } };
    expect(unauthBody.error.code).toBe('unauthenticated');

    const forbiddenPost = await treesRoute.POST(
      new Request(`${ORIGIN}/api/v1/trees`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          'x-test-scopes': 'narrations:read',
        },
        body: JSON.stringify({ title: 'Forbidden' }),
      }),
    );
    expect(forbiddenPost.status).toBe(403);
    const forbiddenBody = (await forbiddenPost.json()) as { error: { code: string } };
    expect(forbiddenBody.error.code).toBe('insufficient_scope');
  });

  it('supports full CRUD, Idempotency-Key replay, expectedRevision 409 conflicts, node reads, and compilation via StudioClient', async () => {
    // 1. Create with Idempotency-Key replay
    const created1 = await client.createTree({
      title: 'Q4 Architecture',
      description: 'Core storage and reader design',
      ops: [{ op: 'put_doc', path: 'overview/01-vision.md', markdown: '# Vision\n\nIntrinsic grid.' }],
      idempotencyKey: 'idem-create-1',
    });
    const created2 = await client.createTree({
      title: 'Q4 Architecture',
      description: 'Core storage and reader design',
      ops: [{ op: 'put_doc', path: 'overview/01-vision.md', markdown: '# Vision\n\nIntrinsic grid.' }],
      idempotencyKey: 'idem-create-1',
    });
    expect(created2.id).toBe(created1.id);
    expect(created1.docCount).toBe(1);
    expect(created1.nodeCount).toBe(2);

    // 2. List & get by id or title
    const listed = await client.listTrees();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created1.id);

    const byTitle = await client.getTree('q4 architecture');
    expect(byTitle.id).toBe(created1.id);

    // 3. Patch metadata
    const patched = await client.updateTree(created1.id, {
      title: 'Q4 System Architecture',
      description: 'Updated description',
    });
    expect(patched.title).toBe('Q4 System Architecture');
    expect(patched.description).toBe('Updated description');

    // 4. Apply ops with Idempotency-Key replay and expectedRevision conflict
    const revBeforeOps = patched.revision;
    const afterOps1 = await client.applyTreeOps(
      created1.id,
      [{ op: 'put_doc', path: 'core/storage.md', markdown: '# Storage Engine\n\nThree-tier topology.' }],
      { expectedRevision: revBeforeOps, idempotencyKey: 'idem-op-1' },
    );
    const afterOps2 = await client.applyTreeOps(
      created1.id,
      [{ op: 'put_doc', path: 'core/storage.md', markdown: '# Storage Engine\n\nThree-tier topology.' }],
      { expectedRevision: revBeforeOps, idempotencyKey: 'idem-op-1' },
    );
    expect(afterOps2.revision).toBe(afterOps1.revision);
    expect(afterOps1.docCount).toBe(2);

    // Stale expectedRevision returns 409 revision_conflict
    let conflictErr: StudioApiError | null = null;
    try {
      await client.applyTreeOps(
        created1.id,
        [{ op: 'mkdir', path: 'stale-folder' }],
        { expectedRevision: revBeforeOps },
      );
    } catch (err) {
      conflictErr = err as StudioApiError;
    }
    expect(conflictErr).toBeInstanceOf(StudioApiError);
    expect(conflictErr?.status).toBe(409);
    expect(conflictErr?.code).toBe('revision_conflict');
    expect(conflictErr?.details).toEqual({ currentRevision: afterOps1.revision });

    // 5. Read document by virtual path (URL-encoded slashes) and by nodeId
    const docByPath = await client.getTreeDocument(created1.id, 'core/storage.md');
    expect(docByPath.title).toBe('Storage Engine');
    expect(docByPath.markdown).toContain('Three-tier topology.');

    const docByNodeId = await client.getTreeDocument(created1.id, docByPath.nodeId);
    expect(docByNodeId.id).toBe(docByPath.id);

    // 5b. PUT /api/v1/trees/[id]/nodes/[nodeId] updates markdown and triggers narration
    const putNodeRes = await treeNodeRoute.PUT(
      new Request(`${ORIGIN}/api/v1/trees/${created1.id}/nodes/${encodeURIComponent('core/storage.md')}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          markdown: '# Storage Engine\n\nThree-tier topology updated.',
          narrate: true,
          voice: 'Aoede',
        }),
      }),
      { params: Promise.resolve({ id: created1.id, nodeId: encodeURIComponent('core/storage.md') }) },
    );
    expect(putNodeRes.status).toBe(200);
    const putNodeBody = (await putNodeRes.json()) as { document: { markdown: string; narrationId: string }; narrationId: string };
    expect(putNodeBody.document.markdown).toContain('Three-tier topology updated.');
    expect(putNodeBody.narrationId).toBe('nar_1');

    // 6. Compile selection and trigger narration
    const compiled = await client.compileTreeSelection(created1.id, {
      targets: ['overview/01-vision.md', 'core/storage.md'],
      title: 'Architecture Briefing',
      saveAsPath: 'compiled/briefing.md',
      narrate: true,
      voice: 'Kore',
    });
    expect(compiled.title).toBe('Architecture Briefing');
    expect(compiled.sourceNodeIds).toHaveLength(2);
    expect(compiled.savedNode?.path).toBe('compiled/briefing.md');
    expect(compiled.narrationId).toBe('nar_2');
    expect(startedNarrations).toHaveLength(2);
    expect(startedNarrations[1]!.voice).toBe('Kore');

    // 7. Delete tree
    const deleted = await client.deleteTree(created1.id);
    expect(deleted).toEqual({ deleted: true, id: created1.id });
    await expect(client.getTree(created1.id)).rejects.toMatchObject({
      status: 404,
      code: 'tree_not_found',
    });
  });
});

describe('mdmedia studio tree CLI subcommands end-to-end', () => {
  const savedEnv = {
    key: process.env.MDMEDIA_API_KEY,
    url: process.env.MDMEDIA_STUDIO_URL,
  };
  let store: InMemoryTreeStore;
  let logs: string[] = [];
  let errors: string[] = [];
  let spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    logs = [];
    errors = [];
    process.exitCode = 0;
    process.env.MDMEDIA_API_KEY = KEY;
    process.env.MDMEDIA_STUDIO_URL = ORIGIN;

    let narCounter = 0;
    store = new InMemoryTreeStore('user_test', {
      async start(_uid, _input) {
        narCounter += 1;
        return { narrationId: `nar_cli_${narCounter}` };
      },
    });
    treesRoute.setTreeStoreForTesting(store, 'user_test');

    const router = createTreeApiRouter();
    spies = [
      spyOn(globalThis, 'fetch').mockImplementation(router),
      spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      }),
      spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    treesRoute.setTreeStoreForTesting(null);
    if (savedEnv.key === undefined) delete process.env.MDMEDIA_API_KEY;
    else process.env.MDMEDIA_API_KEY = savedEnv.key;
    if (savedEnv.url === undefined) delete process.env.MDMEDIA_STUDIO_URL;
    else process.env.MDMEDIA_STUDIO_URL = savedEnv.url;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    process.exitCode = 0;
  });

  it('creates a tree from a local directory (--from-dir), skipping node_modules and .git, then lists and shows it', async () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'overview'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'README.md'), '# Root Readme\n\nWelcome.');
    fs.writeFileSync(path.join(dir, 'overview', '01-intro.md'), '# Intro\n\nFirst chapter.');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'ignored.md'), '# Ignored');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'ignored.md'), '# Ignored Git');

    await runCommand(studioCommand, {
      rawArgs: [
        'tree',
        'create',
        'Handbook',
        '--description',
        'Team docs',
        '--from-dir',
        dir,
        '--json',
      ],
    });
    expect(process.exitCode).toBe(0);
    const createdPayload = JSON.parse(logs.pop()!);
    expect(createdPayload.tree.title).toBe('Handbook');
    expect(createdPayload.tree.description).toBe('Team docs');
    expect(createdPayload.tree.docCount).toBe(2);

    // `tree list` in human and JSON modes
    await runCommand(studioCommand, { rawArgs: ['tree', 'list'] });
    expect(logs.pop()).toContain('Handbook — 2 docs');

    await runCommand(studioCommand, { rawArgs: ['tree', 'list', '--json'] });
    const listPayload = JSON.parse(logs.pop()!);
    expect(listPayload.trees).toHaveLength(1);

    // `tree show <tree>` in human mode prints hierarchy with [ ] markers
    await runCommand(studioCommand, { rawArgs: ['tree', 'show', 'Handbook'] });
    const hierarchyText = logs.pop()!;
    expect(hierarchyText).toContain('Handbook (rev 2)');
    expect(hierarchyText).toContain('[ ]   README.md');
    expect(hierarchyText).toContain('[ ] ▾ overview/');
    expect(hierarchyText).toContain('[ ]   01-intro.md');

    // `tree show <tree> --path <virtual-path>` fetches single document
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'show', 'Handbook', '--path', 'overview/01-intro.md', '--json'],
    });
    const docPayload = JSON.parse(logs.pop()!);
    expect(docPayload.document.title).toBe('Intro');
    expect(docPayload.document.markdown).toContain('First chapter.');
  });

  it('supports put, mkdir, mv, order, organize, select, compile, rm, and delete subcommands', async () => {
    const dir = makeTempDir();
    const localDocPath = path.join(dir, 'local-guide.md');
    fs.writeFileSync(localDocPath, '# Local Guide\n\nUploaded from file.');

    // Create empty tree
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'create', 'Playbook', '--json'],
    });
    const treeId = JSON.parse(logs.pop()!).tree.id as string;

    // `mkdir`
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'mkdir', treeId, 'guides', '--json'],
    });
    expect(JSON.parse(logs.pop()!).tree.nodeCount).toBe(1);

    // `put` with explicit virtual path and local file
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'put', treeId, 'guides/install.md', localDocPath, '--title', 'Install Guide', '--json'],
    });
    const afterPut1 = JSON.parse(logs.pop()!).tree;
    expect(afterPut1.docCount).toBe(1);

    // `put` with --text and --start position
    await runCommand(studioCommand, {
      rawArgs: [
        'tree',
        'put',
        treeId,
        'guides/preface.md',
        '--text',
        '# Preface\n\nRead first.',
        '--start',
        '--revision',
        String(afterPut1.revision),
        '--json',
      ],
    });
    const afterPut2 = JSON.parse(logs.pop()!).tree;
    expect(afterPut2.docCount).toBe(2);
    const guidesFolder = Object.values(afterPut2.nodes).find((n: any) => n.path === 'guides') as any;
    expect(afterPut2.nodes[guidesFolder.childIds[0]].path).toBe('guides/preface.md');

    // `mv` to rename a document
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'mv', treeId, 'guides/install.md', 'guides/setup.md', '--json'],
    });
    const afterMv = JSON.parse(logs.pop()!).tree;
    const movedDoc = Object.values(afterMv.nodes).find((n: any) => n.path === 'guides/setup.md') as any;
    expect(movedDoc).toBeDefined();
    expect(movedDoc.previousPaths).toContain('guides/install.md');

    // `order` children inside folder
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'order', treeId, 'guides', '--children', 'setup.md,preface.md', '--json'],
    });
    const afterOrder = JSON.parse(logs.pop()!).tree;
    const reorderedFolder = Object.values(afterOrder.nodes).find((n: any) => n.path === 'guides') as any;
    expect(reorderedFolder.childIds.map((id: string) => afterOrder.nodes[id].name)).toEqual([
      'setup.md',
      'preface.md',
    ]);

    // `organize` using a JSON plan file
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(
      planFile,
      JSON.stringify([
        {
          path: 'chapters',
          children: [
            { path: 'chapters/01-preface.md', target: 'guides/preface.md' },
            { path: 'chapters/02-setup.md', nodeId: movedDoc.id },
          ],
        },
      ]),
    );
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'organize', treeId, '--plan', planFile, '--json'],
    });
    const afterOrganize = JSON.parse(logs.pop()!).tree;
    expect(Object.values(afterOrganize.nodes).map((n: any) => n.path)).toContain('chapters/01-preface.md');
    expect(Object.values(afterOrganize.nodes).map((n: any) => n.path)).toContain('chapters/02-setup.md');

    // `select` with --save-set and --instructions
    await runCommand(studioCommand, {
      rawArgs: [
        'tree',
        'select',
        treeId,
        'chapters/01-preface.md',
        'chapters/02-setup.md',
        '--save-set',
        'Onboarding Set',
        '--instructions',
        'Combine concisely.',
        '--json',
      ],
    });
    const afterSelect = JSON.parse(logs.pop()!).tree;
    expect(afterSelect.selectedNodeIds).toHaveLength(2);
    expect(afterSelect.selectionSets['onboarding-set']?.title).toBe('Onboarding Set');

    // `compile` using saved preset, --save-as, and --narrate
    await runCommand(studioCommand, {
      rawArgs: [
        'tree',
        'compile',
        treeId,
        '--preset',
        'Onboarding Set',
        '--title',
        'Compiled Onboarding',
        '--save-as',
        'compiled/onboarding.md',
        '--narrate',
        '--voice',
        'Puck',
        '--json',
      ],
    });
    const compilePayload = JSON.parse(logs.pop()!).result;
    expect(compilePayload.title).toBe('Compiled Onboarding');
    expect(compilePayload.savedNode.path).toBe('compiled/onboarding.md');
    expect(compilePayload.narrationId).toBe('nar_cli_1');

    // `select --clear`
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'select', treeId, '--clear', '--json'],
    });
    expect(JSON.parse(logs.pop()!).tree.selectedNodeIds).toEqual([]);

    // `rm` with --no-recursive fails on non-empty folder, succeeds when recursive
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'rm', treeId, 'chapters', '--no-recursive', '--json'],
    });
    expect(process.exitCode).toBe(1);
    const rmErr = JSON.parse(logs.pop()!);
    expect(rmErr.error.code).toBe('folder_not_empty');
    process.exitCode = 0;

    await runCommand(studioCommand, {
      rawArgs: ['tree', 'rm', treeId, 'chapters', '--json'],
    });
    const afterRm = JSON.parse(logs.pop()!).tree;
    expect(Object.values(afterRm.nodes).some((n: any) => n.path.startsWith('chapters'))).toBe(false);

    // `delete`
    await runCommand(studioCommand, {
      rawArgs: ['tree', 'delete', treeId, '--json'],
    });
    expect(JSON.parse(logs.pop()!)).toEqual({ deleted: true, id: treeId });
  });
});
