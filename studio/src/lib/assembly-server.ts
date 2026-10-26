import {
  productionId,
  getProductionCut,
  productionApi,
} from "./productions-server";
import { createHash } from "node:crypto";
import {
  AssemblyError,
  assemblyDuration,
  parseAssembly,
  assemblyFromStoryboard,
  type AssemblyDraft,
} from "mdmedia/assembly";
import { adminDb } from "./firebase-admin";
import { apiError } from "./api-auth";
import {
  loadOwnedAssets,
  productionAssetResource,
} from "./production-media-server";

export class AssemblyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const assemblyHash = (document: unknown) =>
  createHash("sha256").update(JSON.stringify(document)).digest("hex");
const bad = (message: string): never => {
  throw new AssemblyHttpError(400, "invalid_assembly", message);
};
const conflict = (): never => {
  throw new AssemblyHttpError(
    409,
    "assembly_conflict",
    "The draft changed. Export the current draft before updating or publishing.",
  );
};
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function productionRef(id: string) {
  if (!validId(id))
    throw new AssemblyHttpError(
      404,
      "production_not_found",
      "Production not found.",
    );
  return adminDb().collection("productions").doc(id);
}
function owned(uid: string, data: FirebaseFirestore.DocumentData | undefined) {
  if (!data || data.ownerUid !== uid)
    throw new AssemblyHttpError(
      404,
      "production_not_found",
      "Production not found.",
    );
  return data;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    bad("expectedRevision must be a positive integer.");
  return value as number;
}
function key(value: unknown): string {
  if (!validId(value))
    bad(
      "Provide an idempotencyKey of 1–128 letters, digits, underscores or hyphens.",
    );
  return value as string;
}
export async function assemblyApi(
  run: () => Promise<Response>,
): Promise<Response> {
  return productionApi(async () => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof AssemblyHttpError)
        return apiError(e.status, e.code, e.message);
      if (e instanceof AssemblyError) return apiError(422, e.code, e.message);
      throw e;
    }
  });
}
export async function createAssemblyProduction(
  uid: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const token = key(body.idempotencyKey);
  if (!validId(body.storyboardId)) bad("Provide a storyboardId.");
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.length > 200)
  )
    bad("Invalid title.");
  const slug = `assembly-${assemblyHash([uid, token]).slice(0, 24)}`;
  const id = productionId(uid, slug);
  const ref = productionRef(id);
  const fingerprint = assemblyHash([body.storyboardId, body.title ?? null]);
  await adminDb().runTransaction(async (tx) => {
    const before = await tx.get(ref);
    if (before.exists) {
      const existing = owned(uid, before.data());
      if (existing.creationFingerprint !== fingerprint)
        throw new AssemblyHttpError(
          409,
          "idempotency_conflict",
          "This key was used for a different creation.",
        );
      return;
    }
    const board = (
      await tx.get(
        adminDb()
          .collection("storyboards")
          .doc(body.storyboardId as string),
      )
    ).data();
    if (!board || board.ownerUid !== uid)
      throw new AssemblyHttpError(
        404,
        "storyboard_not_found",
        "Storyboard not found.",
      );
    const document = parseAssembly(
      assemblyFromStoryboard(
        body.storyboardId as string,
        board.storyboard.revision,
        board.storyboard.document.beats,
      ),
    );
    const now = Date.now();
    const draft: AssemblyDraft = {
      revision: 1,
      hash: assemblyHash(document),
      updatedAt: now,
      document,
    };
    tx.set(ref, {
      ownerUid: uid,
      title: body.title ?? board.title,
      slug,
      seriesId: null,
      seriesTitle: null,
      coverAssetId: null,
      currentCutId: null,
      approvedCutId: null,
      cuts: [],
      cast: [],
      createdAt: now,
      updatedAt: now,
      reviewedAt: 0,
      assemblyManaged: true,
      creationFingerprint: fingerprint,
    });
    tx.set(
      adminDb().collection(`productions/${id}/assembly`).doc("draft"),
      draft,
    );
  });
  return { id, assembly: await getAssembly(uid, id, origin) };
}
async function assetManifest(
  uid: string,
  document: ReturnType<typeof parseAssembly>,
  origin: string,
) {
  const ids = [...new Set(document.placements.map((p) => p.assetId))];
  const assets = await loadOwnedAssets(uid, ids);
  for (const p of document.placements) {
    const asset = assets.get(p.assetId);
    if (!asset)
      throw new AssemblyHttpError(
        422,
        "asset_not_found",
        `Asset ${p.assetId} is unavailable.`,
      );
    if (
      asset.durationMs !== undefined &&
      p.out > asset.durationMs / 1000 + 0.000001
    )
      bad(`Placement ${p.id} exceeds its source duration.`);
    const type = document.tracks.find((t) => t.id === p.trackId)!.type;
    if (
      type === "video" &&
      !asset.mimeType.startsWith("video/") &&
      !asset.mimeType.startsWith("image/")
    )
      bad(`Placement ${p.id} needs visual media.`);
    if (
      type === "audio" &&
      !asset.mimeType.startsWith("audio/") &&
      !asset.mimeType.startsWith("video/")
    )
      bad(`Placement ${p.id} needs audio media.`);
  }
  return Object.fromEntries(
    [...assets].map(([id, a]) => [id, productionAssetResource(a, origin)]),
  );
}
export async function getAssembly(uid: string, id: string, origin: string) {
  const prod = owned(uid, (await productionRef(id).get()).data());
  if (!prod.assemblyManaged)
    throw new AssemblyHttpError(
      404,
      "assembly_not_found",
      "This production has no assembly draft.",
    );
  const draft = (
    await adminDb().collection(`productions/${id}/assembly`).doc("draft").get()
  ).data() as AssemblyDraft;
  return { ...draft, assets: await assetManifest(uid, draft.document, origin) };
}
export async function updateAssembly(
  uid: string,
  id: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const expected = revision(body.expectedRevision);
  const document = parseAssembly(body.document);
  const ref = productionRef(id);
  owned(uid, (await ref.get()).data());
  await assetManifest(uid, document, origin);
  const draftRef = adminDb()
    .collection(`productions/${id}/assembly`)
    .doc("draft");
  await adminDb().runTransaction(async (tx) => {
    const prod = owned(uid, (await tx.get(ref)).data());
    const draft = (await tx.get(draftRef)).data() as AssemblyDraft | undefined;
    if (!prod.assemblyManaged || !draft)
      throw new AssemblyHttpError(404, "assembly_not_found", "No draft.");
    if (draft.revision !== expected) conflict();
    const now = Date.now();
    tx.set(draftRef, {
      revision: expected + 1,
      hash: assemblyHash(document),
      updatedAt: now,
      document,
    });
    tx.update(ref, { updatedAt: now });
  });
  return getAssembly(uid, id, origin);
}
export async function publishAssembly(
  uid: string,
  id: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const expected = revision(body.expectedRevision);
  const token = key(body.idempotencyKey);
  if (
    typeof body.assemblyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.assemblyHash) ||
    !validId(body.renderedAssetId)
  )
    bad("Provide assemblyHash and renderedAssetId.");
  const label = body.label ?? "Review";
  if (typeof label !== "string" || !label.trim() || label.length > 200)
    bad("Invalid version label.");
  const ref = productionRef(id);
  owned(uid, (await ref.get()).data());
  const cutId = `av${assemblyHash(token).slice(0, 32)}`;
  const cutRef = adminDb().collection(`productions/${id}/cuts`).doc(cutId);
  const fingerprint = assemblyHash([
    expected,
    body.assemblyHash,
    body.renderedAssetId,
    label,
  ]);
  const render = (
    await loadOwnedAssets(uid, [body.renderedAssetId as string])
  ).get(body.renderedAssetId as string);
  if (!render || !render.mimeType.startsWith("video/") || !render.durationMs)
    throw new AssemblyHttpError(
      400,
      "invalid_render",
      "Render must be an owned video with a known duration.",
    );
  await adminDb().runTransaction(async (tx) => {
    const prod = owned(uid, (await tx.get(ref)).data());
    const before = (await tx.get(cutRef)).data();
    if (before) {
      if (before.publicationFingerprint !== fingerprint)
        throw new AssemblyHttpError(
          409,
          "idempotency_conflict",
          "This key was used for another publication.",
        );
      return before;
    }
    const draft = (
      await tx.get(
        adminDb().collection(`productions/${id}/assembly`).doc("draft"),
      )
    ).data() as AssemblyDraft | undefined;
    if (!prod.assemblyManaged || !draft)
      throw new AssemblyHttpError(404, "assembly_not_found", "No draft.");
    if (draft.revision !== expected || draft.hash !== body.assemblyHash)
      conflict();
    const duration = assemblyDuration(draft.document);
    if (duration <= 0) bad("Add timed placements before publishing.");
    if (
      Math.abs(render.durationMs! / 1000 - duration) >
      1 / draft.document.output.fps + 0.000001
    )
      throw new AssemblyHttpError(
        422,
        "render_duration_mismatch",
        "Render duration must match the assembly within one output frame.",
      );
    if (prod.cuts.length >= 200)
      throw new AssemblyHttpError(
        409,
        "too_many_cuts",
        "A production holds at most 200 versions.",
      );
    const now = Date.now();
    const cut = {
      ownerUid: uid,
      productionId: id,
      label,
      status: "review",
      kind: "assembly",
      notes: "",
      order: prod.cuts.length,
      createdAt: now,
      updatedAt: now,
      lengthSeconds: duration,
      cut: null,
      words: null,
      renderedAssetId: render.id,
      posterAssetId: null,
      thumbs: {},
      source: null,
      assembly: draft,
      publicationFingerprint: fingerprint,
    };
    const summary = {
      id: cutId,
      label,
      status: "review",
      kind: "assembly",
      notes: "",
      notesTruncated: false,
      order: cut.order,
      createdAt: now,
      lengthSeconds: duration,
      renderedAssetId: render.id,
      posterAssetId: null,
    };
    tx.set(cutRef, cut);
    tx.update(ref, {
      cuts: [...prod.cuts, summary],
      currentCutId: cutId,
      updatedAt: now,
    });
    return cut;
  });
  return getProductionCut(uid, id, cutId, origin);
}
