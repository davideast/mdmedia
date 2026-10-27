import type { AlignedChunk, AlignedWord, HighlightColorId, NarrationStatus, VoiceName } from './types';
import type { MediaType } from './media-types';

export const MAX_TREE_NODES = 1000;
export const MAX_TREE_DEPTH = 12;
export const MAX_PREVIOUS_PATHS = 10;
export const MAX_INLINE_DOC_BYTES = 200 * 1024;
export const TREE_FILTER_THRESHOLD = 50;

export type TreeId = string;
export type TreeNodeId = string;
export type TreeDocId = string;

export interface TranscriptSourceMapBlock {
  mdStart: number;
  mdEnd: number;
  transcriptStart: number;
  transcriptEnd: number;
}

export interface TranscriptSourceMap {
  version: 1;
  blocks: TranscriptSourceMapBlock[];
}

export interface TreeMediaRef {
  type: MediaType | 'asset' | 'mermaid' | 'text';
  id: string;
  generationId?: string;
}

export interface TreeNodeMeta {
  id: TreeNodeId;
  kind: 'folder' | 'doc';
  name: string;
  /** Normalized virtual path without leading slash, e.g. "architecture/storage.md" */
  path: string;
  /** Historical paths (bounded to MAX_PREVIOUS_PATHS) for move-resilient URL resolution */
  previousPaths: string[];
  parentId: TreeNodeId | null;
  /** Ordered child node IDs when kind === 'folder' */
  childIds: TreeNodeId[];
  /** Reference to treeDocs/{docId} when kind === 'doc' */
  docId: TreeDocId | null;
  narrationId: string | null;
  narrationStatus: 'unvoiced' | NarrationStatus;
  narrationContentHash: string | null;
  updatedAt: number;
}

export interface TreeSelectionSet {
  id: string;
  title: string;
  nodeIds: TreeNodeId[];
  instructions?: string;
  updatedAt: number;
}

/** Stored in `trees/{treeId}/state/selection` to avoid contention on the topology document. */
export interface TreeSelectionState {
  nodeIds: TreeNodeId[];
  revision: number;
  updatedAt: number;
}

export interface TreeSummary {
  id: TreeId;
  title: string;
  description: string;
  nodeCount: number;
  docCount: number;
  selectedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TreeDetail extends TreeSummary {
  rootIds: TreeNodeId[];
  nodes: Record<TreeNodeId, TreeNodeMeta>;
  selectedNodeIds: TreeNodeId[];
  selectionSets: Record<string, TreeSelectionSet>;
  /** Maps normalized relative paths (e.g. "assets/arch.png") to Studio media/assets */
  pathAssets: Record<string, TreeMediaRef>;
  revision: number;
}

export interface TreeDocument {
  id: TreeDocId;
  treeId: TreeId;
  nodeId: TreeNodeId;
  path: string;
  title: string;
  markdown: string;
  contentHash: string;
  narrationId: string | null;
  narrationStatus: 'unvoiced' | NarrationStatus;
  narrationStale: boolean;
  updatedAt: number;
}

/** Relative placement inside a folder's childIds list. */
export type TreePosition = 'start' | 'end' | { before: TreeNodeId } | { after: TreeNodeId };

export interface TreeOrganizeEntry {
  path: string;
  nodeId?: TreeNodeId;
  target?: string;
  title?: string;
  children?: TreeOrganizeEntry[];
}

/** Atomic operations supported by applyTreeOps (Track 1) and POST /api/v1/trees/:id/ops (Track 2). */
export type TreeOp =
  | {
      op: 'put_doc';
      path: string;
      title?: string;
      markdown: string;
      at?: TreePosition;
      nodeId?: TreeNodeId;
    }
  | { op: 'mkdir'; path: string; at?: TreePosition; nodeId?: TreeNodeId }
  | { op: 'move'; target: string; toPath: string; at?: TreePosition }
  | { op: 'reorder'; folderPath: string; childOrder: string[] }
  | { op: 'remove'; targets: string[]; recursive?: boolean }
  | { op: 'select'; targets: string[]; mode: 'set' | 'add' | 'remove' | 'clear' }
  | { op: 'save_selection_set'; id?: string; title: string; targets: string[]; instructions?: string }
  | { op: 'delete_selection_set'; id: string }
  | { op: 'bind_asset'; virtualPath: string; ref: TreeMediaRef }
  | {
      op: 'replace_media_ref';
      nodeId: TreeNodeId;
      from: TreeMediaRef;
      to: TreeMediaRef;
      placement: 'replace' | 'insert_below';
    }
  | { op: 'organize'; entries: TreeOrganizeEntry[] };

export interface TreeCompileRequest {
  /** Uses explicit targets if provided, otherwise preset, otherwise tree.selectedNodeIds */
  targets?: string[];
  preset?: string;
  mode?: 'concat' | 'synthesize';
  title?: string;
  instructions?: string;
  /** If set, writes the compiled markdown back into the tree at this virtual path */
  saveAsPath?: string;
  /** If true, starts a detached Studio narration for the compiled document */
  narrate?: boolean;
  voice?: VoiceName;
  voiceProvider?: 'gemini' | 'elevenlabs';
  voiceId?: string;
  promptStyle?: string;
}

export interface TreeCompileResult {
  title: string;
  markdown: string;
  sourceNodeIds: TreeNodeId[];
  savedNode?: TreeNodeMeta;
  narrationId?: string;
}

export class TreeOpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TreeOpError';
  }
}

// ============================================================================
// PORT 1: Server Persistence Port (Implemented by Track 1, Consumed by Track 2)
// ============================================================================
export interface TreeStorePort {
  listTrees(uid: string): Promise<TreeSummary[]>;
  getTree(uid: string, idOrTitle: string): Promise<TreeDetail>;
  createTree(
    uid: string,
    input: { title: string; description?: string; ops?: readonly TreeOp[]; idempotencyKey?: string },
  ): Promise<TreeDetail>;
  updateTreeMeta(
    uid: string,
    treeId: TreeId,
    patch: { title?: string; description?: string },
  ): Promise<TreeDetail>;
  deleteTree(uid: string, treeId: TreeId): Promise<void>;
  applyOps(
    uid: string,
    treeId: TreeId,
    ops: readonly TreeOp[],
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<TreeDetail>;
  getDocument(uid: string, treeId: TreeId, nodeIdOrPath: string): Promise<TreeDocument>;
  compileSelection(
    uid: string,
    treeId: TreeId,
    request: TreeCompileRequest,
  ): Promise<TreeCompileResult>;
  clearNarrationReferences?(uid: string, narrationId: string): Promise<void>;
}

// ============================================================================
// PORT 2: Detached Narration Starter Port (Injected into Track 1)
// ============================================================================
export interface NarrationStarterPort {
  start(
    uid: string,
    input: {
      markdown: string;
      title: string;
      voice?: VoiceName;
      voiceProvider?: 'gemini' | 'elevenlabs';
      voiceId?: string;
      promptStyle?: string;
      instructions?: string;
      origin?: { treeId: TreeId; nodeId?: TreeNodeId };
    },
  ): Promise<{ narrationId: string }>;
}

// ============================================================================
// PORT 3: Client State & Actions Port (Consumed by Track 3 UI Components)
// ============================================================================
export interface TreeNarrationOptions {
  voice?: VoiceName;
  voiceProvider?: 'gemini' | 'elevenlabs';
  voiceId?: string;
  promptStyle?: string;
}

export interface TreeClientPort {
  listTrees(): Promise<TreeSummary[]>;
  watchTree(treeId: TreeId, onUpdate: (tree: TreeDetail | null) => void): () => void;
  watchDocument(
    treeId: TreeId,
    nodeId: TreeNodeId,
    onUpdate: (doc: TreeDocument | null) => void,
  ): () => void;
  applyOps(
    treeId: TreeId,
    ops: readonly TreeOp[],
    options?: { expectedRevision?: number },
  ): Promise<TreeDetail>;
  compileSelection(treeId: TreeId, request: TreeCompileRequest): Promise<TreeCompileResult>;
  startNodeNarration(
    treeId: TreeId,
    nodeId: TreeNodeId,
    options?: TreeNarrationOptions,
  ): Promise<{ narrationId: string }>;
}

// ============================================================================
// PORT 4: Cross-Modal Media Remix & Unified Reader Contracts (Track 4)
// ============================================================================
export type MediaRemixKind =
  | 'image_to_image'
  | 'image_to_video_first_frame'
  | 'image_to_video_reference'
  | 'image_to_music'
  | 'video_extend'
  | 'video_edit'
  | 'video_to_image'
  | 'mermaid_to_image'
  | 'text_to_image'
  | 'text_to_video'
  | 'text_to_music';

export interface MediaRemixRequest {
  kind: MediaRemixKind;
  source:
    | TreeMediaRef
    | { type: 'mermaid'; code: string }
    | { type: 'text'; text: string; id?: string };
  prompt: string;
  placement: 'replace' | 'insert_below' | 'library_only';
}

export interface MediaRemixResult {
  createdRef: TreeMediaRef;
  updatedMarkdown?: string;
}

export interface TreeDocumentReaderProps {
  document: TreeDocument;
  pathAssets: Record<string, TreeMediaRef>;
  words?: readonly AlignedWord[];
  chunks?: readonly AlignedChunk[];
  sourceMap?: TranscriptSourceMap;
  activeCharStart: number | null;
  activeCharEnd: number | null;
  spokenThrough: number;
  audioLoaded: boolean;
  loadedDurationMs: number;
  narrationActive?: boolean;
  highlightColor?: HighlightColorId;
  onSeekWord?: (startMs: number) => void;
  onRemixMedia?: (request: MediaRemixRequest) => Promise<MediaRemixResult>;
  resolveDocHref?: (rawHref: string) => string | null;
  onNavigateDocHref?: (resolvedHref: string) => void;
  className?: string;
}
