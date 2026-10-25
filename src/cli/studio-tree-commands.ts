import fs from 'node:fs';
import path from 'node:path';
import { defineCommand } from 'citty';
import type {
  StudioClient,
  TreeCompileRequest,
  TreeCompileResult,
  TreeDetail,
  TreeDocument,
  TreeNodeId,
  TreeNodeMeta,
  TreeOp,
  TreeOrganizeEntry,
  TreePosition,
  TreeSummary,
} from '../remote/client.js';
import { oneOf } from './studio-media-commands.js';
import { connectedClient, guarded } from './studio-support.js';

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', '.hg', '.svn', 'dist', 'build']);

const treeArg = {
  type: 'positional',
  required: true,
  description: 'Tree id or exact title',
} as const;

const jsonArg = {
  type: 'boolean',
  description: 'Print JSON',
} as const;

const revisionArg = {
  type: 'string',
  description: 'Expected tree revision for optimistic concurrency check',
} as const;

const positionArgs = {
  start: { type: 'boolean', description: 'Place at the start of the parent folder' },
  end: { type: 'boolean', description: 'Place at the end of the parent folder (default)' },
  before: { type: 'string', description: 'Place before this sibling node id' },
  after: { type: 'string', description: 'Place after this sibling node id' },
} as const;

type PositionFlags = {
  start?: boolean;
  end?: boolean;
  before?: string;
  after?: string;
};

export function treePositionFrom(args: PositionFlags): TreePosition | undefined {
  const given = [
    args.start && 'start',
    args.end && 'end',
    args.before && 'before',
    args.after && 'after',
  ].filter(Boolean);
  if (given.length > 1) {
    throw new Error('Pass only one of --start, --end, --before, --after.');
  }
  if (args.start) return 'start';
  if (args.end) return 'end';
  if (args.before) return { before: args.before };
  if (args.after) return { after: args.after };
  return undefined;
}

export function parseExpectedRevision(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--revision must be a positive integer (got "${raw}").`);
  }
  return parsed;
}

/**
 * Recursively scans `dirPath` for `.md` files (skipping `node_modules` and `.git`),
 * returning `put_doc` operations sorted deterministically by relative virtual path.
 */
export async function scanMarkdownDir(dirPath: string): Promise<TreeOp[]> {
  const rootDir = path.resolve(dirPath);
  const stat = await fs.promises.stat(rootDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`--from-dir "${dirPath}" is not a directory.`);
  }

  const foundFiles: { virtualPath: string; fullPath: string }[] = [];

  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        foundFiles.push({ virtualPath: relPath, fullPath });
      }
    }
  }

  await walk(rootDir, '');
  foundFiles.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));

  const ops: TreeOp[] = [];
  for (const file of foundFiles) {
    const markdown = await fs.promises.readFile(file.fullPath, 'utf8');
    ops.push({
      op: 'put_doc',
      path: file.virtualPath,
      markdown,
    });
  }
  return ops;
}

export function treeSummaryLine(tree: TreeSummary): string {
  return `${tree.id}  ${tree.title} — ${tree.docCount} docs, ${tree.nodeCount} nodes, ${tree.selectedCount} selected`;
}

export function formatTreeHierarchy(tree: TreeDetail): string {
  const lines: string[] = [
    `${tree.id}  ${tree.title} (rev ${tree.revision}) — ${tree.docCount} docs, ${tree.selectedCount} selected`,
  ];
  if (tree.description) {
    lines.push(tree.description);
  }
  const selectedSet = new Set(tree.selectedNodeIds);

  function folderSelectionMarker(node: TreeNodeMeta): '[x]' | '[-]' | '[ ]' {
    const docIds: TreeNodeId[] = [];
    const collect = (n: TreeNodeMeta) => {
      if (n.kind === 'doc') docIds.push(n.id);
      else {
        for (const cId of n.childIds) {
          const child = tree.nodes[cId];
          if (child) collect(child);
        }
      }
    };
    collect(node);
    if (docIds.length === 0) return '[ ]';
    const selectedCount = docIds.filter((id) => selectedSet.has(id)).length;
    if (selectedCount === 0) return '[ ]';
    if (selectedCount === docIds.length) return '[x]';
    return '[-]';
  }

  function visit(ids: readonly TreeNodeId[], depth: number): void {
    const indent = '  '.repeat(depth);
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      if (node.kind === 'folder') {
        const marker = folderSelectionMarker(node);
        lines.push(`${indent}${marker} ▾ ${node.name}/ (${node.id}) [${node.path}]`);
        visit(node.childIds, depth + 1);
      } else {
        const marker = selectedSet.has(node.id) ? '[x]' : '[ ]';
        lines.push(`${indent}${marker}   ${node.name} (${node.id}) [${node.path}]`);
      }
    }
  }

  if (tree.rootIds.length === 0) {
    lines.push('(empty tree)');
  } else {
    visit(tree.rootIds, 0);
  }
  return lines.join('\n');
}

function printTree(tree: TreeDetail, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify({ tree }, null, 2));
    return;
  }
  console.log(formatTreeHierarchy(tree));
}

function printDocument(document: TreeDocument, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify({ document }, null, 2));
    return;
  }
  console.log(`${document.path} (${document.nodeId}) — ${document.title}\n`);
  console.log(document.markdown);
}

function printCompileResult(result: TreeCompileResult, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify({ result }, null, 2));
    return;
  }
  const meta: string[] = [`Compiled "${result.title}" (${result.sourceNodeIds.length} docs)`];
  if (result.savedNode) meta.push(`saved to ${result.savedNode.path} (${result.savedNode.id})`);
  if (result.narrationId) meta.push(`narration ${result.narrationId}`);
  console.log(meta.join(' — '));
  console.log(result.markdown);
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const treeList = defineCommand({
  meta: { name: 'list', description: 'List your Markdown trees, most recently updated first' },
  args: { json: jsonArg },
  async run({ args }) {
    await guarded(args.json, async () => {
      const trees = await connectedClient().listTrees();
      if (args.json) {
        console.log(JSON.stringify({ trees }, null, 2));
        return;
      }
      if (trees.length === 0) {
        console.log('No trees yet.');
        return;
      }
      for (const tree of trees) {
        console.log(treeSummaryLine(tree));
      }
    });
  },
});

const treeShow = defineCommand({
  meta: { name: 'show', description: 'Show a tree hierarchy or a single document with --path' },
  args: {
    tree: treeArg,
    path: { type: 'string', description: 'Virtual path or node id of a document to read' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const client = connectedClient();
      if (args.path) {
        const document = await client.getTreeDocument(args.tree, args.path);
        printDocument(document, args.json);
        return;
      }
      const tree = await client.getTree(args.tree);
      printTree(tree, args.json);
    });
  },
});

const treeCreate = defineCommand({
  meta: { name: 'create', description: 'Create a Markdown tree, optionally populated from a local folder' },
  args: {
    title: { type: 'positional', required: true, description: 'Tree title' },
    description: { type: 'string', description: 'Optional description' },
    fromDir: { type: 'string', alias: 'dir', description: 'Local directory of .md files to import' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const rawArgs = args as Record<string, unknown>;
      const fromDir = (args.fromDir ?? rawArgs['from-dir'] ?? rawArgs.dir) as string | undefined;
      const ops = fromDir ? await scanMarkdownDir(fromDir) : undefined;
      const tree = await connectedClient().createTree({
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(ops && ops.length > 0 ? { ops } : {}),
      });
      printTree(tree, args.json);
    });
  },
});

const treePut = defineCommand({
  meta: {
    name: 'put',
    description: 'Create or update a Markdown document in a tree',
  },
  args: {
    tree: treeArg,
    target: { type: 'positional', required: true, description: 'Virtual path in tree (or local file path)' },
    file: { type: 'positional', required: false, description: 'Local Markdown file path' },
    title: { type: 'string', description: 'Document title override' },
    input: { type: 'string', alias: 'i', description: 'Local file to read Markdown from (- for stdin)' },
    text: { type: 'string', alias: 't', description: 'Inline Markdown text' },
    stdin: { type: 'boolean', description: 'Read Markdown from stdin' },
    ...positionArgs,
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const pos1 = positionals[1] ?? args.target;
      const pos2 = positionals[2] ?? args.file;
      if (!pos1) {
        throw new Error('Specify a virtual path or local Markdown file.');
      }

      const at = treePositionFrom(args);
      const expectedRevision = parseExpectedRevision(args.revision);
      let virtualPath = pos1;
      let markdown: string;

      if (args.text !== undefined) {
        markdown = args.text;
      } else if (args.stdin || args.input === '-') {
        markdown = await readStdinText();
      } else if (args.input !== undefined) {
        markdown = await fs.promises.readFile(args.input, 'utf8');
      } else if (pos2 !== undefined) {
        markdown = await fs.promises.readFile(pos2, 'utf8');
      } else {
        // Single positional after <tree>: read from local file `pos1`
        markdown = await fs.promises.readFile(pos1, 'utf8');
        if (path.isAbsolute(pos1) || pos1.startsWith('..')) {
          virtualPath = path.basename(pos1);
        } else {
          virtualPath = pos1.replace(/\\/g, '/').replace(/^\.\//, '');
        }
      }

      const op: TreeOp = {
        op: 'put_doc',
        path: virtualPath,
        markdown,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(at ? { at } : {}),
      };

      const tree = await connectedClient().applyTreeOps(
        treeIdOrTitle,
        [op],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeMkdir = defineCommand({
  meta: { name: 'mkdir', description: 'Create a folder in a tree' },
  args: {
    tree: treeArg,
    path: { type: 'positional', required: true, description: 'Virtual folder path' },
    ...positionArgs,
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const at = treePositionFrom(args);
      const expectedRevision = parseExpectedRevision(args.revision);
      const op: TreeOp = {
        op: 'mkdir',
        path: args.path,
        ...(at ? { at } : {}),
      };
      const tree = await connectedClient().applyTreeOps(
        args.tree,
        [op],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeMv = defineCommand({
  meta: { name: 'mv', description: 'Move or rename a node in a tree' },
  args: {
    tree: treeArg,
    target: { type: 'positional', required: true, description: 'Node id or current path' },
    toPath: { type: 'positional', required: true, description: 'New virtual path' },
    ...positionArgs,
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const target = positionals[1] ?? args.target;
      const toPath = positionals[2] ?? args.toPath;
      if (!target || !toPath) {
        throw new Error('Usage: mdmedia studio tree mv <tree> <target> <to-path>');
      }
      const at = treePositionFrom(args);
      const expectedRevision = parseExpectedRevision(args.revision);
      const op: TreeOp = {
        op: 'move',
        target,
        toPath,
        ...(at ? { at } : {}),
      };
      const tree = await connectedClient().applyTreeOps(
        treeIdOrTitle,
        [op],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeRm = defineCommand({
  meta: { name: 'rm', description: 'Remove one or more nodes from a tree' },
  args: {
    tree: treeArg,
    target: { type: 'positional', required: true, description: 'Node id or path to remove' },
    recursive: { type: 'boolean', default: true, description: 'Remove folders recursively (--no-recursive to refuse non-empty folders)' },
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const targets = positionals.slice(1);
      if (targets.length === 0 && args.target) {
        targets.push(args.target);
      }
      if (targets.length === 0) {
        throw new Error('Specify at least one target node id or path to remove.');
      }
      const rawArgs = args as Record<string, unknown>;
      const recursive =
        args.recursive !== false && rawArgs['no-recursive'] !== true && rawArgs.noRecursive !== true;
      const expectedRevision = parseExpectedRevision(args.revision);
      const op: TreeOp = {
        op: 'remove',
        targets,
        recursive,
      };
      const tree = await connectedClient().applyTreeOps(
        treeIdOrTitle,
        [op],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeOrder = defineCommand({
  meta: { name: 'order', description: 'Reorder direct children of the root or a folder' },
  args: {
    tree: treeArg,
    folderPath: { type: 'positional', required: false, description: 'Folder path (omit or "" for root)' },
    children: { type: 'string', description: 'Comma-separated list of child names, paths, or node ids' },
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const folderPath = positionals[1] ?? args.folderPath ?? '';
      const childOrder = (args.children ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (childOrder.length === 0) {
        throw new Error('Pass --children <a,b,c> with the ordered child names or node ids.');
      }
      const expectedRevision = parseExpectedRevision(args.revision);
      const op: TreeOp = {
        op: 'reorder',
        folderPath,
        childOrder,
      };
      const tree = await connectedClient().applyTreeOps(
        treeIdOrTitle,
        [op],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeOrganize = defineCommand({
  meta: { name: 'organize', description: 'Declaratively reorganize tree nodes from a JSON plan' },
  args: {
    tree: treeArg,
    plan: { type: 'string', alias: 'manifest', description: 'Path to JSON plan file (- for stdin)' },
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const rawArgs = args as Record<string, unknown>;
      const planSource = (args.plan ?? rawArgs.manifest) as string | undefined;
      if (!planSource) {
        throw new Error('Pass --plan <plan.json> (or - for stdin).');
      }
      const rawJson =
        planSource === '-' ? await readStdinText() : await fs.promises.readFile(planSource, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new Error(`--plan "${planSource}" is not valid JSON.`);
      }
      const entries: TreeOrganizeEntry[] | undefined = Array.isArray(parsed)
        ? (parsed as TreeOrganizeEntry[])
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries)
          ? ((parsed as { entries: TreeOrganizeEntry[] }).entries)
          : undefined;
      if (!entries) {
        throw new Error('--plan must be a JSON array of organize entries or an object with an "entries" array.');
      }
      const expectedRevision = parseExpectedRevision(args.revision);
      const tree = await connectedClient().applyTreeOps(
        args.tree,
        [{ op: 'organize', entries }],
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeSelect = defineCommand({
  meta: { name: 'select', description: 'Update the active selection or save a named selection preset' },
  args: {
    tree: treeArg,
    add: { type: 'boolean', description: 'Add targets to current selection' },
    remove: { type: 'boolean', description: 'Remove targets from current selection' },
    clear: { type: 'boolean', description: 'Clear all selected nodes' },
    set: { type: 'boolean', description: 'Replace current selection with targets (default)' },
    saveSet: { type: 'string', description: 'Save targets as a named selection preset' },
    instructions: { type: 'string', description: 'Compilation instructions for --save-set' },
    revision: revisionArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const targets = positionals.slice(1);
      const rawArgs = args as Record<string, unknown>;
      const saveSet = (args.saveSet ?? rawArgs['save-set']) as string | undefined;

      const modes = [
        args.add && 'add',
        args.remove && 'remove',
        args.clear && 'clear',
        args.set && 'set',
      ].filter(Boolean) as Array<'add' | 'remove' | 'clear' | 'set'>;
      if (modes.length > 1) {
        throw new Error('Pass at most one of --add, --remove, --clear, --set.');
      }
      const mode: 'add' | 'remove' | 'clear' | 'set' = modes[0] ?? 'set';

      if (mode !== 'clear' && targets.length === 0) {
        throw new Error('Specify at least one target node id or path, or pass --clear.');
      }

      const ops: TreeOp[] = [{ op: 'select', targets: mode === 'clear' ? [] : targets, mode }];
      if (saveSet !== undefined) {
        ops.push({
          op: 'save_selection_set',
          title: saveSet,
          targets,
          ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
        });
      }

      const expectedRevision = parseExpectedRevision(args.revision);
      const tree = await connectedClient().applyTreeOps(
        treeIdOrTitle,
        ops,
        expectedRevision !== undefined ? { expectedRevision } : undefined,
      );
      printTree(tree, args.json);
    });
  },
});

const treeCompile = defineCommand({
  meta: {
    name: 'compile',
    description: 'Compile selected documents into a single document and optionally narrate it',
  },
  args: {
    tree: treeArg,
    preset: { type: 'string', description: 'Selection preset id or title' },
    mode: { type: 'string', description: 'Compilation mode: concat or synthesize' },
    title: { type: 'string', description: 'Title for the compiled document' },
    instructions: { type: 'string', description: 'Custom synthesis instructions' },
    saveAs: { type: 'string', description: 'Save compiled document into the tree at this virtual path' },
    narrate: { type: 'boolean', description: 'Start a studio narration for the compiled document' },
    voice: { type: 'string', alias: 'v', description: 'Voice name for narration' },
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const positionals = args._.map(String);
      const treeIdOrTitle = positionals[0] ?? args.tree;
      const targets = positionals.slice(1);
      const rawArgs = args as Record<string, unknown>;
      const saveAs = (args.saveAs ?? rawArgs['save-as']) as string | undefined;
      const mode = oneOf('--mode', args.mode, ['concat', 'synthesize'] as const);

      const request: TreeCompileRequest = {
        ...(targets.length > 0 ? { targets } : {}),
        ...(args.preset !== undefined ? { preset: args.preset } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
        ...(saveAs !== undefined ? { saveAsPath: saveAs } : {}),
        ...(args.narrate !== undefined ? { narrate: args.narrate } : {}),
        ...(args.voice !== undefined ? { voice: args.voice } : {}),
      };

      const result = await connectedClient().compileTreeSelection(treeIdOrTitle, request);
      printCompileResult(result, args.json);
    });
  },
});

const treeDelete = defineCommand({
  meta: { name: 'delete', description: 'Delete a tree (its detached narrations are kept)' },
  args: {
    tree: treeArg,
    json: jsonArg,
  },
  async run({ args }) {
    await guarded(args.json, async () => {
      const result = await connectedClient().deleteTree(args.tree);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Deleted tree ${result.id}.`);
    });
  },
});

export const treeCommand = defineCommand({
  meta: {
    name: 'tree',
    description: 'Create, organize, select, and compile hierarchical Markdown document trees',
  },
  subCommands: {
    list: treeList,
    show: treeShow,
    create: treeCreate,
    put: treePut,
    mkdir: treeMkdir,
    mv: treeMv,
    rm: treeRm,
    order: treeOrder,
    organize: treeOrganize,
    select: treeSelect,
    compile: treeCompile,
    delete: treeDelete,
  },
});
