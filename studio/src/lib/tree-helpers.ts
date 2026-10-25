/** Shared tree navigation and Markdown helpers, safe to import in the browser. */
import { MAX_TREE_DEPTH, TreeOpError, type TreeDetail, type TreeMediaRef, type TreeNodeId, type TreeNodeMeta } from './tree-types';

export function normalizeVirtualPath(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!cleaned) throw new TreeOpError('invalid_path', 'Path must not be empty.');
  const parts = cleaned.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new TreeOpError('invalid_path', `Invalid path segment in "${raw}".`);
    }
    if (part.length > 200) {
      throw new TreeOpError('invalid_path', `Path segment "${part.slice(0, 32)}…" exceeds 200 characters.`);
    }
    if (/[\u0000-\u001f]/.test(part)) {
      throw new TreeOpError('invalid_path', 'Path segments cannot contain control characters.');
    }
  }
  if (parts.length > MAX_TREE_DEPTH) {
    throw new TreeOpError('max_depth_exceeded', `Path "${cleaned}" exceeds maximum depth of ${MAX_TREE_DEPTH}.`);
  }
  return parts.join('/');
}

export function deriveDocTitle(markdown: string, fallbackName: string): string {
  const match = markdown.match(/^\s{0,3}#{1,3}\s+(.+)$/m);
  if (match && match[1]) {
    const cleaned = match[1].replace(/[*_`~#]/g, '').trim();
    if (cleaned) return cleaned.slice(0, 200);
  }
  return fallbackName.replace(/\.md$/i, '');
}

export function formatMediaMarkdownRef(ref: TreeMediaRef, label = 'Media'): string {
  if (ref.type === 'mermaid') return `\`\`\`mermaid\n${ref.id}\n\`\`\``;
  const suffix = ref.generationId ? `@${ref.generationId}` : '';
  const uri = `mdmedia://${ref.type}/${ref.id}${suffix}`;
  if (ref.type === 'music' || ref.type === 'sfx') {
    return `[${label}](${uri})`;
  }
  return `![${label}](${uri})`;
}

/** Pre-order traversal of tree nodes in visual tree order. */
export function walkTreeOrder(
  rootIds: readonly TreeNodeId[],
  nodes: Record<TreeNodeId, TreeNodeMeta>,
): TreeNodeMeta[] {
  const result: TreeNodeMeta[] = [];
  const visit = (ids: readonly TreeNodeId[]) => {
    for (const id of ids) {
      const node = nodes[id];
      if (!node) continue;
      result.push(node);
      if (node.kind === 'folder' && node.childIds.length > 0) {
        visit(node.childIds);
      }
    }
  };
  visit(rootIds);
  return result;
}

/**
 * Resolves a node in `tree` by:
 * 1. Exact node ID match
 * 2. Exact path match (with or without `.md` extension for doc nodes)
 * 3. Historical `previousPaths` match (picking the most recently updated node on collision)
 */
export function resolveTreeNode(
  tree: Pick<TreeDetail, 'nodes'>,
  targetOrPath: string,
): { node: TreeNodeMeta; matchedVia: 'id' | 'path' | 'previous_path' } | null {
  const raw = targetOrPath.trim();
  if (!raw) return null;
  if (tree.nodes[raw]) {
    return { node: tree.nodes[raw]!, matchedVia: 'id' };
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const withMd = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  const withoutMd = normalized.replace(/\.md$/i, '');

  const allNodes = Object.values(tree.nodes);
  for (const node of allNodes) {
    if (node.path === normalized || (node.kind === 'doc' && (node.path === withMd || node.path === withoutMd))) {
      return { node, matchedVia: 'path' };
    }
  }

  let bestPrev: TreeNodeMeta | null = null;
  for (const node of allNodes) {
    const matchesPrev = node.previousPaths.some(
      (prev) => prev === normalized || (node.kind === 'doc' && (prev === withMd || prev === withoutMd)),
    );
    if (matchesPrev && (!bestPrev || node.updatedAt >= bestPrev.updatedAt)) {
      bestPrev = node;
    }
  }
  if (bestPrev) {
    return { node: bestPrev, matchedVia: 'previous_path' };
  }
  return null;
}

