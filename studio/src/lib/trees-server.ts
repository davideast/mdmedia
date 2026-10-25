import {
  MAX_INLINE_DOC_BYTES,
  TreeOpError,
  type NarrationStarterPort,
  type TreeCompileRequest,
  type TreeCompileResult,
  type TreeDetail,
  type TreeDocId,
  type TreeDocument,
  type TreeId,
  type TreeMediaRef,
  type TreeNodeId,
  type TreeNodeMeta,
  type TreeOp,
  type TreeSelectionSet,
  type TreeSelectionState,
  type TreeStorePort,
  type TreeSummary,
} from './tree-types';
import {
  applyTreeOpsState,
  hashContent,
  resolveTreeNode,
  validateTreeDescription,
  validateTreeTitle,
  walkTreeOrder,
} from './tree-ops';
import { adminBucket, adminDb } from './firebase-admin';
import { DEFAULT_TTS_MODEL, type NarrationStatus, type VoiceName } from './types';

/** Maximum number of `treeDocs` mutations per Firestore WriteBatch (staying safely under Firestore's 500 limit). */
export const MAX_FIRESTORE_BATCH_DOCS = 400;

export interface StoredTreeTopologyDoc {
  id: TreeId;
  ownerUid: string;
  title: string;
  description: string;
  nodeCount: number;
  docCount: number;
  selectedCount: number;
  rootIds: TreeNodeId[];
  nodes: Record<TreeNodeId, TreeNodeMeta>;
  selectedNodeIds: TreeNodeId[];
  selectionSets: Record<string, TreeSelectionSet>;
  pathAssets: Record<string, TreeMediaRef>;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredTreeDocRecord {
  id: TreeDocId;
  ownerUid: string;
  treeId: TreeId;
  nodeId: TreeNodeId;
  path: string;
  title: string;
  markdown: string;
  storagePath: string | null;
  byteSize: number;
  contentHash: string;
  narrationId: string | null;
  narrationStatus: 'unvoiced' | NarrationStatus;
  narrationStale: boolean;
  updatedAt: number;
}

export interface TreeDatabaseAdapter {
  allocateId(prefix: string): string;
  getTreeDoc(treeId: TreeId): Promise<StoredTreeTopologyDoc | null>;
  listTreeDocsByOwner(uid: string): Promise<StoredTreeTopologyDoc[]>;
  setTreeDoc(treeId: TreeId, data: StoredTreeTopologyDoc): Promise<void>;
  deleteTreeDoc(treeId: TreeId): Promise<void>;
  getSelectionState(treeId: TreeId): Promise<TreeSelectionState | null>;
  setSelectionState(treeId: TreeId, state: TreeSelectionState): Promise<void>;
  deleteSelectionState(treeId: TreeId): Promise<void>;
  getDocumentRecord(docId: TreeDocId): Promise<StoredTreeDocRecord | null>;
  listDocumentRecordsByTree(uid: string, treeId: TreeId): Promise<StoredTreeDocRecord[]>;
  commitDocumentBatch(puts: readonly StoredTreeDocRecord[], deletes: readonly TreeDocId[]): Promise<void>;
  getIdempotencyRecord(key: string): Promise<TreeDetail | null>;
  setIdempotencyRecord(key: string, detail: TreeDetail): Promise<void>;
}

export interface TreeBlobStorageAdapter {
  writeBlob(storagePath: string, content: string, metadata?: Record<string, string>): Promise<void>;
  readBlob(storagePath: string): Promise<string | null>;
  deleteBlob(storagePath: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export function treeBlobObjectPath(uid: string, treeId: TreeId, docId: TreeDocId): string {
  return `trees/${uid}/${treeId}/blobs/${docId}.md`;
}

/**
 * In-memory persistence and blob adapters for deterministic unit and contract tests
 * of `FirestoreTreeStore` without requiring live GCP credentials.
 */
export class InMemoryTreeDatabaseAdapter implements TreeDatabaseAdapter {
  readonly trees = new Map<TreeId, StoredTreeTopologyDoc>();
  readonly selections = new Map<TreeId, TreeSelectionState>();
  readonly treeDocs = new Map<TreeDocId, StoredTreeDocRecord>();
  readonly idempotency = new Map<string, TreeDetail>();
  readonly batchCommits: Array<{ putCount: number; deleteCount: number }> = [];
  private counter = 0;

  allocateId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  async getTreeDoc(treeId: TreeId): Promise<StoredTreeTopologyDoc | null> {
    const doc = this.trees.get(treeId);
    return doc ? structuredClone(doc) : null;
  }

  async listTreeDocsByOwner(uid: string): Promise<StoredTreeTopologyDoc[]> {
    return [...this.trees.values()]
      .filter((t) => t.ownerUid === uid)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => structuredClone(t));
  }

  async setTreeDoc(treeId: TreeId, data: StoredTreeTopologyDoc): Promise<void> {
    this.trees.set(treeId, structuredClone(data));
  }

  async deleteTreeDoc(treeId: TreeId): Promise<void> {
    this.trees.delete(treeId);
  }

  async getSelectionState(treeId: TreeId): Promise<TreeSelectionState | null> {
    const state = this.selections.get(treeId);
    return state ? structuredClone(state) : null;
  }

  async setSelectionState(treeId: TreeId, state: TreeSelectionState): Promise<void> {
    this.selections.set(treeId, structuredClone(state));
  }

  async deleteSelectionState(treeId: TreeId): Promise<void> {
    this.selections.delete(treeId);
  }

  async getDocumentRecord(docId: TreeDocId): Promise<StoredTreeDocRecord | null> {
    const rec = this.treeDocs.get(docId);
    return rec ? structuredClone(rec) : null;
  }

  async listDocumentRecordsByTree(uid: string, treeId: TreeId): Promise<StoredTreeDocRecord[]> {
    return [...this.treeDocs.values()]
      .filter((d) => d.ownerUid === uid && d.treeId === treeId)
      .map((d) => structuredClone(d));
  }

  async commitDocumentBatch(puts: readonly StoredTreeDocRecord[], deletes: readonly TreeDocId[]): Promise<void> {
    const totalOps = puts.length + deletes.length;
    if (totalOps > 500) {
      throw new Error(`Firestore batch limit exceeded: ${totalOps} operations in a single batch (max 500).`);
    }
    this.batchCommits.push({ putCount: puts.length, deleteCount: deletes.length });
    for (const put of puts) {
      this.treeDocs.set(put.id, structuredClone(put));
    }
    for (const delId of deletes) {
      this.treeDocs.delete(delId);
    }
  }

  async getIdempotencyRecord(key: string): Promise<TreeDetail | null> {
    const cached = this.idempotency.get(key);
    return cached ? structuredClone(cached) : null;
  }

  async setIdempotencyRecord(key: string, detail: TreeDetail): Promise<void> {
    this.idempotency.set(key, structuredClone(detail));
  }
}

export class InMemoryTreeBlobStorageAdapter implements TreeBlobStorageAdapter {
  readonly blobs = new Map<string, { content: string; metadata?: Record<string, string> }>();

  async writeBlob(storagePath: string, content: string, metadata?: Record<string, string>): Promise<void> {
    this.blobs.set(storagePath, { content, ...(metadata ? { metadata: { ...metadata } } : {}) });
  }

  async readBlob(storagePath: string): Promise<string | null> {
    return this.blobs.get(storagePath)?.content ?? null;
  }

  async deleteBlob(storagePath: string): Promise<void> {
    this.blobs.delete(storagePath);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.blobs.keys()]) {
      if (key.startsWith(prefix)) {
        this.blobs.delete(key);
      }
    }
  }
}

export function createInMemoryTreePersistenceAdapter(): {
  db: InMemoryTreeDatabaseAdapter;
  storage: InMemoryTreeBlobStorageAdapter;
} {
  return {
    db: new InMemoryTreeDatabaseAdapter(),
    storage: new InMemoryTreeBlobStorageAdapter(),
  };
}

/**
 * Production adapters backed by Firebase Admin Firestore (`adminDb()`) and Cloud Storage (`adminBucket()`).
 */
export class FirebaseAdminTreeDatabaseAdapter implements TreeDatabaseAdapter {
  private readonly idempotencyCache = new Map<string, TreeDetail>();

  allocateId(prefix: string): string {
    const raw = adminDb().collection('trees').doc().id;
    return `${prefix}_${raw}`;
  }

  async getTreeDoc(treeId: TreeId): Promise<StoredTreeTopologyDoc | null> {
    const snap = await adminDb().collection('trees').doc(treeId).get();
    if (!snap.exists) return null;
    return { ...(snap.data() as StoredTreeTopologyDoc), id: snap.id };
  }

  async listTreeDocsByOwner(uid: string): Promise<StoredTreeTopologyDoc[]> {
    const snap = await adminDb()
      .collection('trees')
      .where('ownerUid', '==', uid)
      .orderBy('updatedAt', 'desc')
      .limit(200)
      .get();
    return snap.docs.map((doc) => ({ ...(doc.data() as StoredTreeTopologyDoc), id: doc.id }));
  }

  async setTreeDoc(treeId: TreeId, data: StoredTreeTopologyDoc): Promise<void> {
    await adminDb().collection('trees').doc(treeId).set(data);
  }

  async deleteTreeDoc(treeId: TreeId): Promise<void> {
    await adminDb().collection('trees').doc(treeId).delete();
  }

  async getSelectionState(treeId: TreeId): Promise<TreeSelectionState | null> {
    const snap = await adminDb().collection('trees').doc(treeId).collection('state').doc('selection').get();
    if (!snap.exists) return null;
    return snap.data() as TreeSelectionState;
  }

  async setSelectionState(treeId: TreeId, state: TreeSelectionState): Promise<void> {
    await adminDb().collection('trees').doc(treeId).collection('state').doc('selection').set(state);
  }

  async deleteSelectionState(treeId: TreeId): Promise<void> {
    await adminDb()
      .collection('trees')
      .doc(treeId)
      .collection('state')
      .doc('selection')
      .delete()
      .catch(() => {});
  }

  async getDocumentRecord(docId: TreeDocId): Promise<StoredTreeDocRecord | null> {
    const snap = await adminDb().collection('treeDocs').doc(docId).get();
    if (!snap.exists) return null;
    return { ...(snap.data() as StoredTreeDocRecord), id: snap.id };
  }

  async listDocumentRecordsByTree(uid: string, treeId: TreeId): Promise<StoredTreeDocRecord[]> {
    const snap = await adminDb()
      .collection('treeDocs')
      .where('ownerUid', '==', uid)
      .where('treeId', '==', treeId)
      .get();
    return snap.docs.map((doc) => ({ ...(doc.data() as StoredTreeDocRecord), id: doc.id }));
  }

  async commitDocumentBatch(puts: readonly StoredTreeDocRecord[], deletes: readonly TreeDocId[]): Promise<void> {
    if (puts.length === 0 && deletes.length === 0) return;
    const batch = adminDb().batch();
    for (const put of puts) {
      batch.set(adminDb().collection('treeDocs').doc(put.id), put);
    }
    for (const delId of deletes) {
      batch.delete(adminDb().collection('treeDocs').doc(delId));
    }
    await batch.commit();
  }

  async getIdempotencyRecord(key: string): Promise<TreeDetail | null> {
    const cached = this.idempotencyCache.get(key);
    return cached ? structuredClone(cached) : null;
  }

  async setIdempotencyRecord(key: string, detail: TreeDetail): Promise<void> {
    this.idempotencyCache.set(key, structuredClone(detail));
  }
}

export class FirebaseAdminTreeBlobStorageAdapter implements TreeBlobStorageAdapter {
  async writeBlob(storagePath: string, content: string, metadata?: Record<string, string>): Promise<void> {
    const bucket = adminBucket();
    await bucket.file(storagePath).save(Buffer.from(content, 'utf8'), {
      contentType: 'text/markdown; charset=utf-8',
      resumable: false,
      ...(metadata ? { metadata: { metadata } } : {}),
    });
  }

  async readBlob(storagePath: string): Promise<string | null> {
    const file = adminBucket().file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [bytes] = await file.download();
    return bytes.toString('utf8');
  }

  async deleteBlob(storagePath: string): Promise<void> {
    try {
      const bucket = adminBucket() as {
        file?: (p: string) => { delete: (opts?: { ignoreNotFound?: boolean }) => Promise<unknown> };
      };
      if (typeof bucket?.file === 'function') {
        await bucket.file(storagePath).delete({ ignoreNotFound: true });
      }
    } catch {
      // Best-effort cleanup in local sandbox or missing object
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      const bucket = adminBucket() as {
        deleteFiles?: (opts: { prefix: string; force?: boolean }) => Promise<unknown>;
      };
      if (typeof bucket?.deleteFiles === 'function') {
        await bucket.deleteFiles({ prefix, force: true });
      }
    } catch {
      // Best-effort cleanup when bucket adapter does not support prefix deletion
    }
  }
}

export function createDefaultNarrationStarter(): NarrationStarterPort {
  return {
    async start(uid, input) {
      const { startNarration } = await import('./narration-start');
      const voice: VoiceName = input.voice ?? 'Puck';
      const voiceProvider = input.voiceProvider ?? 'gemini';
      const voiceId = input.voiceId ?? voice;
      const promptStyle = input.promptStyle?.trim() ?? '';
      const instructions = input.instructions?.trim() || undefined;
      const detached = new AbortController();
      const started = await startNarration({
        uid,
        request: {
          markdown: input.markdown,
          voice,
          voiceProvider,
          voiceId,
          model: DEFAULT_TTS_MODEL,
          promptStyle,
          rewriteForNarration: Boolean(instructions),
          ...(instructions ? { rewriteInstructions: instructions } : {}),
          verbalizeDiagrams: false,
          visibility: 'private',
        },
        signal: detached.signal,
      });
      if (!started.ok) {
        throw new TreeOpError(started.code, started.message, started.status);
      }
      detached.abort();
      void started.stream.cancel().catch(() => {});
      return { narrationId: started.id };
    },
  };
}

export interface FirestoreTreeStoreDeps {
  db?: TreeDatabaseAdapter;
  storage?: TreeBlobStorageAdapter;
  narrationStarter?: NarrationStarterPort;
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

export class FirestoreTreeStore implements TreeStorePort {
  private readonly db: TreeDatabaseAdapter;
  private readonly storage: TreeBlobStorageAdapter;
  private readonly narrationStarter?: NarrationStarterPort;

  constructor(deps: FirestoreTreeStoreDeps = {}) {
    this.db = deps.db ?? new FirebaseAdminTreeDatabaseAdapter();
    this.storage = deps.storage ?? new FirebaseAdminTreeBlobStorageAdapter();
    this.narrationStarter = deps.narrationStarter;
  }

  private toTreeDetail(topology: StoredTreeTopologyDoc, selection: TreeSelectionState | null): TreeDetail {
    const rawSelectedIds =
      selection && selection.revision >= topology.revision ? selection.nodeIds : topology.selectedNodeIds;
    const selectedSet = new Set(rawSelectedIds);
    const mergedSelectedNodeIds = walkTreeOrder(topology.rootIds, topology.nodes)
      .filter((n) => n.kind === 'doc' && selectedSet.has(n.id))
      .map((n) => n.id);

    return {
      id: topology.id,
      title: topology.title,
      description: topology.description,
      nodeCount: topology.nodeCount,
      docCount: topology.docCount,
      selectedCount: mergedSelectedNodeIds.length,
      rootIds: structuredClone(topology.rootIds),
      nodes: structuredClone(topology.nodes),
      selectedNodeIds: mergedSelectedNodeIds,
      selectionSets: structuredClone(topology.selectionSets),
      pathAssets: structuredClone(topology.pathAssets),
      revision: Math.max(topology.revision, selection?.revision ?? 0),
      createdAt: topology.createdAt,
      updatedAt: Math.max(topology.updatedAt, selection?.updatedAt ?? 0),
    };
  }

  private toTreeSummary(detail: TreeDetail): TreeSummary {
    return {
      id: detail.id,
      title: detail.title,
      description: detail.description,
      nodeCount: detail.nodeCount,
      docCount: detail.docCount,
      selectedCount: detail.selectedCount,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
  }

  private toTopologyDoc(uid: string, detail: TreeDetail): StoredTreeTopologyDoc {
    return {
      id: detail.id,
      ownerUid: uid,
      title: detail.title,
      description: detail.description,
      nodeCount: detail.nodeCount,
      docCount: detail.docCount,
      selectedCount: detail.selectedCount,
      rootIds: structuredClone(detail.rootIds),
      nodes: structuredClone(detail.nodes),
      selectedNodeIds: structuredClone(detail.selectedNodeIds),
      selectionSets: structuredClone(detail.selectionSets),
      pathAssets: structuredClone(detail.pathAssets),
      revision: detail.revision,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
  }

  private async requireOwnedTree(uid: string, idOrTitle: string): Promise<TreeDetail> {
    const trimmed = idOrTitle.trim();
    if (!trimmed) {
      throw new TreeOpError('tree_not_found', 'Tree id or title must be non-empty.', 404);
    }

    const direct = await this.db.getTreeDoc(trimmed);
    if (direct && direct.ownerUid === uid) {
      const sel = await this.db.getSelectionState(direct.id);
      return this.toTreeDetail(direct, sel);
    }

    const owned = await this.db.listTreeDocsByOwner(uid);
    const wanted = trimmed.toLowerCase();
    const matches = owned.filter((t) => t.title.trim().toLowerCase() === wanted);
    if (matches.length > 1) {
      throw new TreeOpError(
        'tree_ambiguous',
        `${matches.length} trees are titled "${idOrTitle}". Use the id instead.`,
        409,
        { ids: matches.map((m) => m.id) },
      );
    }
    if (!matches[0]) {
      throw new TreeOpError('tree_not_found', `No tree with id or title "${idOrTitle}".`, 404);
    }
    const sel = await this.db.getSelectionState(matches[0].id);
    return this.toTreeDetail(matches[0], sel);
  }

  private async hydrateTreeDocument(record: StoredTreeDocRecord): Promise<TreeDocument> {
    let markdown = record.markdown;
    if (record.storagePath) {
      const blobContent = await this.storage.readBlob(record.storagePath);
      if (blobContent === null) {
        throw new TreeOpError('doc_not_found', `Spillover blob "${record.storagePath}" not found.`, 404);
      }
      markdown = blobContent;
    }
    return {
      id: record.id,
      treeId: record.treeId,
      nodeId: record.nodeId,
      path: record.path,
      title: record.title,
      markdown,
      contentHash: record.contentHash,
      narrationId: record.narrationId,
      narrationStatus: record.narrationStatus,
      narrationStale: record.narrationStale,
      updatedAt: record.updatedAt,
    };
  }

  private async prepareStoredDocRecord(
    uid: string,
    doc: TreeDocument,
    previousRecord?: StoredTreeDocRecord,
  ): Promise<StoredTreeDocRecord> {
    const byteSize = Buffer.byteLength(doc.markdown, 'utf8');
    if (byteSize > MAX_INLINE_DOC_BYTES) {
      const storagePath = treeBlobObjectPath(uid, doc.treeId, doc.id);
      await this.storage.writeBlob(storagePath, doc.markdown, {
        ownerUid: uid,
        treeId: doc.treeId,
        docId: doc.id,
      });
      return {
        id: doc.id,
        ownerUid: uid,
        treeId: doc.treeId,
        nodeId: doc.nodeId,
        path: doc.path,
        title: doc.title,
        markdown: '',
        storagePath,
        byteSize,
        contentHash: doc.contentHash,
        narrationId: doc.narrationId,
        narrationStatus: doc.narrationStatus,
        narrationStale: doc.narrationStale,
        updatedAt: doc.updatedAt,
      };
    }

    if (previousRecord?.storagePath) {
      await this.storage.deleteBlob(previousRecord.storagePath);
    }

    return {
      id: doc.id,
      ownerUid: uid,
      treeId: doc.treeId,
      nodeId: doc.nodeId,
      path: doc.path,
      title: doc.title,
      markdown: doc.markdown,
      storagePath: null,
      byteSize,
      contentHash: doc.contentHash,
      narrationId: doc.narrationId,
      narrationStatus: doc.narrationStatus,
      narrationStale: doc.narrationStale,
      updatedAt: doc.updatedAt,
    };
  }

  private async commitDocsInChunks(
    puts: readonly StoredTreeDocRecord[],
    deletes: readonly TreeDocId[],
  ): Promise<void> {
    type BatchItem = { kind: 'put'; record: StoredTreeDocRecord } | { kind: 'delete'; docId: TreeDocId };
    const items: BatchItem[] = [
      ...puts.map((record): BatchItem => ({ kind: 'put', record })),
      ...deletes.map((docId): BatchItem => ({ kind: 'delete', docId })),
    ];
    if (items.length === 0) return;

    const chunks = chunkArray(items, MAX_FIRESTORE_BATCH_DOCS);
    for (const chunk of chunks) {
      const chunkPuts: StoredTreeDocRecord[] = [];
      const chunkDeletes: TreeDocId[] = [];
      for (const item of chunk) {
        if (item.kind === 'put') chunkPuts.push(item.record);
        else chunkDeletes.push(item.docId);
      }
      await this.db.commitDocumentBatch(chunkPuts, chunkDeletes);
    }
  }

  async listTrees(uid: string): Promise<TreeSummary[]> {
    const topologies = await this.db.listTreeDocsByOwner(uid);
    const details = await Promise.all(
      topologies.map(async (top) => {
        const sel = await this.db.getSelectionState(top.id);
        return this.toTreeDetail(top, sel);
      }),
    );
    return details
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((detail) => this.toTreeSummary(detail));
  }

  async getTree(uid: string, idOrTitle: string): Promise<TreeDetail> {
    return this.requireOwnedTree(uid, idOrTitle);
  }

  async createTree(
    uid: string,
    input: { title: string; description?: string; ops?: readonly TreeOp[]; idempotencyKey?: string },
  ): Promise<TreeDetail> {
    const idemKey = input.idempotencyKey ? `${uid}:create:${input.idempotencyKey}` : null;
    if (idemKey) {
      const cached = await this.db.getIdempotencyRecord(idemKey);
      if (cached) return cached;
    }

    const title = validateTreeTitle(input.title);
    const description = validateTreeDescription(input.description);
    const now = Date.now();
    const id = this.db.allocateId('tr');

    const initialDetail: TreeDetail = {
      id,
      title,
      description,
      nodeCount: 0,
      docCount: 0,
      selectedCount: 0,
      rootIds: [],
      nodes: {},
      selectedNodeIds: [],
      selectionSets: {},
      pathAssets: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.setTreeDoc(id, this.toTopologyDoc(uid, initialDetail));
    await this.db.setSelectionState(id, {
      nodeIds: [],
      revision: 1,
      updatedAt: now,
    });

    let finalDetail = initialDetail;
    if (input.ops && input.ops.length > 0) {
      finalDetail = await this.applyOps(uid, id, input.ops);
    }

    if (idemKey) {
      await this.db.setIdempotencyRecord(idemKey, finalDetail);
    }
    return structuredClone(finalDetail);
  }

  async updateTreeMeta(
    uid: string,
    treeId: TreeId,
    patch: { title?: string; description?: string },
  ): Promise<TreeDetail> {
    const detail = await this.requireOwnedTree(uid, treeId);
    if (patch.title !== undefined) {
      detail.title = validateTreeTitle(patch.title);
    }
    if (patch.description !== undefined) {
      detail.description = validateTreeDescription(patch.description);
    }
    detail.revision += 1;
    detail.updatedAt = Date.now();

    await this.db.setTreeDoc(detail.id, this.toTopologyDoc(uid, detail));
    await this.db.setSelectionState(detail.id, {
      nodeIds: detail.selectedNodeIds,
      revision: detail.revision,
      updatedAt: detail.updatedAt,
    });

    return structuredClone(detail);
  }

  async deleteTree(uid: string, treeId: TreeId): Promise<void> {
    const detail = await this.requireOwnedTree(uid, treeId);
    const existingDocs = await this.db.listDocumentRecordsByTree(uid, detail.id);

    // 1. Delete any Cloud Storage blobs for this tree (never touching detached narrations)
    await Promise.all(
      existingDocs
        .filter((d) => Boolean(d.storagePath))
        .map((d) => this.storage.deleteBlob(d.storagePath!)),
    );
    await this.storage.deletePrefix(`trees/${uid}/${detail.id}/blobs/`);

    // 2. Delete all `treeDocs` records in chunks of <= 400
    const docIds = existingDocs.map((d) => d.id);
    await this.commitDocsInChunks([], docIds);

    // 3. Delete selection subdocument and topology document
    await this.db.deleteSelectionState(detail.id);
    await this.db.deleteTreeDoc(detail.id);
  }

  async applyOps(
    uid: string,
    treeId: TreeId,
    ops: readonly TreeOp[],
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<TreeDetail> {
    const currentDetail = await this.requireOwnedTree(uid, treeId);
    const idemKey = options?.idempotencyKey
      ? `${uid}:ops:${currentDetail.id}:${options.idempotencyKey}`
      : null;
    if (idemKey) {
      const cached = await this.db.getIdempotencyRecord(idemKey);
      if (cached) return cached;
    }

    if (options?.expectedRevision !== undefined && options.expectedRevision !== currentDetail.revision) {
      throw new TreeOpError(
        'revision_conflict',
        `Expected tree revision ${options.expectedRevision}, but current revision is ${currentDetail.revision}.`,
        409,
        { currentRevision: currentDetail.revision },
      );
    }

    const existingRecords = await this.db.listDocumentRecordsByTree(uid, currentDetail.id);
    const recordByDocId = new Map<TreeDocId, StoredTreeDocRecord>();
    const hydratedDocs = new Map<TreeNodeId, TreeDocument>();

    for (const rec of existingRecords) {
      recordByDocId.set(rec.id, rec);
      const hydrated = await this.hydrateTreeDocument(rec);
      hydratedDocs.set(rec.nodeId, hydrated);
    }

    const result = applyTreeOpsState({
      detail: currentDetail,
      docs: hydratedDocs,
      ops,
      now: Date.now(),
      nextId: (prefix) => this.db.allocateId(prefix),
    });

    // Phase 1: Prepare and commit `treeDocs/{docId}` in chunks of <= 400 before topology commit
    const recordsToPut: StoredTreeDocRecord[] = [];
    for (const nodeId of result.touchedDocNodeIds) {
      const updatedDoc = result.docs.get(nodeId);
      if (!updatedDoc) continue;
      const prevRec = recordByDocId.get(updatedDoc.id);
      const prepared = await this.prepareStoredDocRecord(uid, updatedDoc, prevRec);
      recordsToPut.push(prepared);
    }

    for (const deletedDocId of result.deletedDocIds) {
      const prevRec = recordByDocId.get(deletedDocId);
      if (prevRec?.storagePath) {
        await this.storage.deleteBlob(prevRec.storagePath);
      }
    }

    await this.commitDocsInChunks(recordsToPut, result.deletedDocIds);

    // Phase 2: Commit selection state and topology document
    await this.db.setSelectionState(result.detail.id, {
      nodeIds: result.detail.selectedNodeIds,
      revision: result.detail.revision,
      updatedAt: result.detail.updatedAt,
    });
    await this.db.setTreeDoc(result.detail.id, this.toTopologyDoc(uid, result.detail));

    if (idemKey) {
      await this.db.setIdempotencyRecord(idemKey, result.detail);
    }

    return structuredClone(result.detail);
  }

  async getDocument(uid: string, treeId: TreeId, nodeIdOrPath: string): Promise<TreeDocument> {
    const detail = await this.requireOwnedTree(uid, treeId);
    const resolved = resolveTreeNode(detail, nodeIdOrPath);
    if (!resolved || resolved.node.kind !== 'doc' || !resolved.node.docId) {
      throw new TreeOpError('doc_not_found', `Document "${nodeIdOrPath}" not found in tree.`, 404);
    }
    const record = await this.db.getDocumentRecord(resolved.node.docId);
    if (!record || record.ownerUid !== uid || record.treeId !== detail.id) {
      throw new TreeOpError('doc_not_found', `Document "${nodeIdOrPath}" content not found.`, 404);
    }
    return this.hydrateTreeDocument(record);
  }

  async compileSelection(
    uid: string,
    treeId: TreeId,
    request: TreeCompileRequest,
  ): Promise<TreeCompileResult> {
    const detail = await this.requireOwnedTree(uid, treeId);
    let targetIds: TreeNodeId[];

    if (request.targets && request.targets.length > 0) {
      const requested = new Set<TreeNodeId>();
      const addDescendants = (node: TreeNodeMeta) => {
        if (node.kind === 'doc') requested.add(node.id);
        else {
          for (const childId of node.childIds) {
            const child = detail.nodes[childId];
            if (child) addDescendants(child);
          }
        }
      };
      for (const target of request.targets) {
        const res = resolveTreeNode(detail, target);
        if (!res) {
          throw new TreeOpError('node_not_found', `Node "${target}" not found.`, 404);
        }
        addDescendants(res.node);
      }
      targetIds = walkTreeOrder(detail.rootIds, detail.nodes)
        .filter((n) => requested.has(n.id))
        .map((n) => n.id);
    } else if (request.preset) {
      const preset =
        detail.selectionSets[request.preset] ??
        Object.values(detail.selectionSets).find(
          (s) => s.title.toLowerCase() === request.preset!.trim().toLowerCase(),
        );
      if (!preset) {
        throw new TreeOpError('preset_not_found', `Selection preset "${request.preset}" not found.`, 404);
      }
      const set = new Set(preset.nodeIds);
      targetIds = walkTreeOrder(detail.rootIds, detail.nodes)
        .filter((n) => set.has(n.id))
        .map((n) => n.id);
    } else {
      const set = new Set(detail.selectedNodeIds);
      targetIds = walkTreeOrder(detail.rootIds, detail.nodes)
        .filter((n) => set.has(n.id))
        .map((n) => n.id);
    }

    if (targetIds.length === 0) {
      throw new TreeOpError('empty_selection', 'Select at least one document to compile.', 400);
    }

    const docs: TreeDocument[] = [];
    for (const nodeId of targetIds) {
      const doc = await this.getDocument(uid, detail.id, nodeId);
      docs.push(doc);
    }

    const title = request.title?.trim() || `${detail.title} Briefing`;
    const sections = docs.map((d) => {
      const trimmed = d.markdown.trim();
      if (/^#\s+/.test(trimmed)) {
        return trimmed.replace(/^#(\s+)/, '##$1');
      }
      return `## ${d.title}\n\n${trimmed}`;
    });
    const instructionsNote = request.instructions?.trim()
      ? `> **Briefing focus:** ${request.instructions.trim()}\n\n`
      : '';
    const markdown = `# ${title}\n\n${instructionsNote}${sections.join('\n\n---\n\n')}\n`;

    let savedNode: TreeNodeMeta | undefined;
    if (request.saveAsPath) {
      const updated = await this.applyOps(uid, detail.id, [
        { op: 'put_doc', path: request.saveAsPath, title, markdown },
      ]);
      savedNode = resolveTreeNode(updated, request.saveAsPath)?.node;
    }

    let narrationId: string | undefined;
    if (request.narrate && this.narrationStarter) {
      const started = await this.narrationStarter.start(uid, {
        markdown,
        title,
        voice: request.voice,
        voiceProvider: request.voiceProvider,
        voiceId: request.voiceId,
        promptStyle: request.promptStyle,
        instructions: request.instructions,
        origin: { treeId: detail.id, nodeId: savedNode?.id },
      });
      narrationId = started.narrationId;
      if (savedNode) {
        savedNode = await this.attachNarrationToNode(uid, detail.id, savedNode.id, narrationId, hashContent(markdown));
      }
    }

    return {
      title,
      markdown,
      sourceNodeIds: targetIds,
      ...(savedNode ? { savedNode } : {}),
      ...(narrationId ? { narrationId } : {}),
    };
  }

  async startNodeNarration(
    uid: string,
    treeId: TreeId,
    nodeIdOrPath: string,
    options?: {
      voice?: VoiceName;
      voiceProvider?: 'gemini' | 'elevenlabs';
      voiceId?: string;
      promptStyle?: string;
    },
  ): Promise<{ narrationId: string }> {
    const detail = await this.requireOwnedTree(uid, treeId);
    const doc = await this.getDocument(uid, detail.id, nodeIdOrPath);
    const starter = this.narrationStarter ?? createDefaultNarrationStarter();
    const { narrationId } = await starter.start(uid, {
      markdown: doc.markdown,
      title: doc.title,
      voice: options?.voice,
      voiceProvider: options?.voiceProvider,
      voiceId: options?.voiceId,
      promptStyle: options?.promptStyle,
      origin: { treeId: detail.id, nodeId: doc.nodeId },
    });
    await this.attachNarrationToNode(uid, detail.id, doc.nodeId, narrationId, doc.contentHash);
    return { narrationId };
  }

  private async attachNarrationToNode(
    uid: string,
    treeId: TreeId,
    nodeId: TreeNodeId,
    narrationId: string,
    contentHash: string,
  ): Promise<TreeNodeMeta | undefined> {
    const detail = await this.requireOwnedTree(uid, treeId);
    const node = detail.nodes[nodeId];
    if (!node) return undefined;

    const now = Date.now();
    node.narrationId = narrationId;
    node.narrationStatus = 'ready';
    node.narrationContentHash = contentHash;
    node.updatedAt = now;
    detail.revision += 1;
    detail.updatedAt = now;

    await this.db.setTreeDoc(detail.id, this.toTopologyDoc(uid, detail));

    if (node.docId) {
      const rec = await this.db.getDocumentRecord(node.docId);
      if (rec && rec.ownerUid === uid) {
        rec.narrationId = narrationId;
        rec.narrationStatus = 'ready';
        rec.narrationStale = false;
        rec.updatedAt = now;
        await this.commitDocsInChunks([rec], []);
      }
    }
    return structuredClone(node);
  }

  async clearNarrationReferences(uid: string, narrationId: string): Promise<void> {
    const topologies = await this.db.listTreeDocsByOwner(uid);
    const now = Date.now();

    for (const topology of topologies) {
      let treeChanged = false;
      for (const node of Object.values(topology.nodes)) {
        if (node.narrationId === narrationId) {
          node.narrationId = null;
          node.narrationStatus = 'unvoiced';
          node.narrationContentHash = null;
          node.updatedAt = now;
          treeChanged = true;
        }
      }

      const docs = await this.db.listDocumentRecordsByTree(uid, topology.id);
      const updatedDocs: StoredTreeDocRecord[] = [];
      for (const docRec of docs) {
        if (docRec.narrationId === narrationId) {
          docRec.narrationId = null;
          docRec.narrationStatus = 'unvoiced';
          docRec.narrationStale = false;
          docRec.updatedAt = now;
          updatedDocs.push(docRec);
        }
      }

      if (updatedDocs.length > 0) {
        await this.commitDocsInChunks(updatedDocs, []);
      }

      if (treeChanged) {
        topology.revision += 1;
        topology.updatedAt = now;
        await this.db.setTreeDoc(topology.id, topology);
      }
    }
  }
}

export function createFirestoreTreeStore(deps: FirestoreTreeStoreDeps = {}): FirestoreTreeStore {
  return new FirestoreTreeStore(deps);
}

let serverTreeStoreSingleton: TreeStorePort | null = null;

export function getServerTreeStore(): TreeStorePort {
  if (!serverTreeStoreSingleton) {
    serverTreeStoreSingleton = createFirestoreTreeStore({
      narrationStarter: createDefaultNarrationStarter(),
    });
  }
  return serverTreeStoreSingleton;
}

export function setServerTreeStoreForTests(store: TreeStorePort | null): void {
  serverTreeStoreSingleton = store;
}

export async function clearNarrationReferences(uid: string, narrationId: string): Promise<void> {
  const store = getServerTreeStore();
  if (store.clearNarrationReferences) {
    await store.clearNarrationReferences(uid, narrationId);
  }
}
