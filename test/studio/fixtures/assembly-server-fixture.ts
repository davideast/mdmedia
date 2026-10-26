import { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { mock } from "bun:test";
import assert from "node:assert/strict";
type Data = Record<string, unknown>;
type Sortable = string | number;
const documents = new Map<string, Data>();
const files = new Map<string, Buffer>();
let sequence = 0;
const watchers = new Set<() => void>();
const notifyWatchers = () => {
  for (const fn of watchers) fn();
};
let transactionTail = Promise.resolve();
class Ref {
  constructor(readonly path: string) {}
  get id() {
    return this.path.split("/").at(-1)!;
  }
  async get() {
    const data = documents.get(this.path);
    return {
      ref: this,
      id: this.id,
      exists: !!data,
      data: () => (data ? structuredClone(data) : undefined),
    };
  }
  async set(data: Data) {
    documents.set(this.path, structuredClone(data));
    notifyWatchers();
  }
  async update(patch: Data) {
    assert(documents.has(this.path), `Missing ${this.path}`);
    documents.set(this.path, {
      ...documents.get(this.path),
      ...structuredClone(patch),
    });
    notifyWatchers();
  }
  async delete() {
    documents.delete(this.path);
    notifyWatchers();
  }
}
interface Transaction {
  get(ref: Ref): ReturnType<Ref["get"]>;
  set(ref: Ref, data: Data): void;
  update(ref: Ref, data: Data): void;
  delete(ref: Ref): void;
}
/** Collections at any depth: `productions/{id}/cuts` lists only that production's cuts. */
class Query {
  constructor(
    readonly collection: string,
    readonly filters: Array<[string, string, unknown]> = [],
    readonly orders: Array<[string, string]> = [],
    readonly cap = Infinity,
  ) {}
  doc(id = `auto${++sequence}`) {
    return new Ref(`${this.collection}/${id}`);
  }
  where(field: string, op: string, value: unknown) {
    return new Query(
      this.collection,
      [...this.filters, [field, op, value]],
      this.orders,
      this.cap,
    );
  }
  orderBy(field: string, direction = "asc") {
    return new Query(
      this.collection,
      this.filters,
      [...this.orders, [field, direction]],
      this.cap,
    );
  }
  limit(cap: number) {
    return new Query(this.collection, this.filters, this.orders, cap);
  }
  onSnapshot(next: (snap: unknown) => void) {
    let active = true;
    const notify = () => {
      void this.get().then((s) => {
        if (active) next(s);
      });
    };
    watchers.add(notify);
    notify();
    return () => {
      active = false;
      watchers.delete(notify);
    };
  }
  async get() {
    const depth = this.collection.split("/").length + 1;
    let entries = [...documents.entries()].filter(
      ([path]) =>
        path.startsWith(`${this.collection}/`) &&
        path.split("/").length === depth,
    );
    entries = entries.filter(([, data]) =>
      this.filters.every(
        ([field, op, expected]) => op === "==" && data[field] === expected,
      ),
    );
    for (const [field, direction] of [...this.orders].reverse())
      entries.sort((a, b) => {
        const x = a[1][field] as Sortable;
        const y = b[1][field] as Sortable;
        return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1);
      });
    return {
      empty: entries.length === 0,
      docs: entries.slice(0, this.cap).map(([path]) => {
        const ref = new Ref(path);
        return {
          id: ref.id,
          ref,
          data: () => structuredClone(documents.get(path)),
        };
      }),
    };
  }
}
const db = {
  collection: (name: string) => new Query(name),
  async runTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    const previous = transactionTail;
    let release!: () => void;
    transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const writes: (() => Promise<void>)[] = [];
    let writing = false;
    const write = (step: () => Promise<void>) => {
      writing = true;
      writes.push(step);
    };
    try {
      const result = await run({
        get: (ref: Ref) => {
          assert(!writing, "Read after write in transaction");
          return ref.get();
        },
        set: (ref: Ref, data: Data) => write(() => ref.set(data)),
        update: (ref: Ref, data: Data) => write(() => ref.update(data)),
        delete: (ref: Ref) => write(() => ref.delete()),
      });
      for (const step of writes) await step();
      return result;
    } finally {
      release();
    }
  },
};

const bucket = {
  file(path: string) {
    return {
      async save(bytes: Buffer) {
        files.set(path, Buffer.from(bytes));
      },
      async download() {
        assert(files.has(path), "Missing storage object");
        return [files.get(path)];
      },
      async getMetadata() {
        assert(files.has(path), "Missing storage object");
        return [{ size: String(files.get(path)!.length) }];
      },
      async delete() {
        files.delete(path);
      },
      createReadStream(range: { start?: number; end?: number } = {}) {
        return Readable.from([
          files
            .get(path)!
            .subarray(
              range.start ?? 0,
              range.end === undefined ? undefined : range.end + 1,
            ),
        ]);
      },
      // Like Storage: nothing is visible until the stream finishes; a destroyed stream stores nothing.
      createWriteStream() {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk));
            done();
          },
          final(done) {
            files.set(path, Buffer.concat(chunks));
            done();
          },
        });
      },
    };
  },
};

mock.module("../../../studio/src/lib/firebase-admin", () => ({
  adminDb: () => db,
  adminBucket: () => bucket,
  isAllowlisted: async () => true,
  verifyUser: async (header: string) =>
    header === "Bearer owner"
      ? { uid: "owner", email: "owner@example.test" }
      : header === "Bearer other"
        ? { uid: "other", email: "other@example.test" }
        : null,
}));

const api = await import("../../../studio/src/lib/assembly-server");
const { assemblyFromStoryboard } = await import("../../../src/assembly/index");
documents.set("storyboards/sb1", {
  ownerUid: "owner",
  title: "Demo",
  storyboard: {
    revision: 1,
    document: {
      beats: [
        {
          id: "intro",
          title: "Start",
          script: "Hello",
          visual: "Screen",
          notes: "",
        },
      ],
    },
  },
});
const created = await api.createAssemblyProduction(
  "owner",
  { storyboardId: "sb1", idempotencyKey: "create-one" },
  "http://studio.test",
);
const again = await api.createAssemblyProduction(
  "owner",
  { storyboardId: "sb1", idempotencyKey: "create-one" },
  "http://studio.test",
);
assert.equal(created.id, again.id);
await assert.rejects(
  () =>
    api.createAssemblyProduction(
      "owner",
      { storyboardId: "sb1", title: "Different", idempotencyKey: "create-one" },
      "http://studio.test",
    ),
  (e: any) => e.code === "idempotency_conflict",
);
let draft = await api.getAssembly("owner", created.id, "http://studio.test");
assert.equal(draft.revision, 1);
assert.equal(draft.document.scenes[0].id, "intro");
assert.equal(draft.document.placements.length, 0);
await assert.rejects(() =>
  api.getAssembly("other", created.id, "http://studio.test"),
);
const changed = {
  ...draft.document,
  scenes: [{ ...draft.document.scenes[0], title: "New" }],
};
const writes = await Promise.allSettled([
  api.updateAssembly(
    "owner",
    created.id,
    { expectedRevision: 1, document: changed },
    "http://studio.test",
  ),
  api.updateAssembly(
    "owner",
    created.id,
    { expectedRevision: 1, document: changed },
    "http://studio.test",
  ),
]);
assert.equal(writes.filter((x) => x.status === "fulfilled").length, 1);
draft = await api.getAssembly("owner", created.id, "http://studio.test");
assert.equal(draft.revision, 2);
assert.equal(draft.document.scenes[0].title, "New");
console.log(
  "PASS: storyboard handoff, idempotency, ownership, draft concurrency",
);
for (const [id, durationMs, mimeType] of [
  ["source", 6000, "video/mp4"],
  ["render", 4000, "video/mp4"],
  ["short", 2000, "video/mp4"],
] as const)
  documents.set(`mediaAssets/${id}`, {
    id,
    ownerUid: "owner",
    durationMs,
    mimeType,
    byteLength: 100,
    width: 1920,
    height: 1080,
    mediaType: "video",
  });
const assembly = {
  ...draft.document,
  tracks: [{ id: "picture", name: "Picture", type: "video" }],
  placements: [
    {
      id: "shot",
      trackId: "picture",
      assetId: "source",
      start: 0,
      in: 2,
      out: 6,
      sceneId: "intro",
    },
  ],
};
await assert.rejects(() =>
  api.updateAssembly(
    "owner",
    created.id,
    {
      expectedRevision: 2,
      document: {
        ...assembly,
        placements: [{ ...assembly.placements[0], out: 7 }],
      },
    },
    "http://studio.test",
  ),
);
await assert.rejects(() =>
  api.updateAssembly(
    "owner",
    created.id,
    {
      expectedRevision: 2,
      document: {
        ...assembly,
        placements: [{ ...assembly.placements[0], assetId: "foreign" }],
      },
    },
    "http://studio.test",
  ),
);
draft = await api.updateAssembly(
  "owner",
  created.id,
  { expectedRevision: 2, document: assembly },
  "http://studio.test",
);
const publish = {
  expectedRevision: 3,
  assemblyHash: draft.hash,
  renderedAssetId: "render",
  idempotencyKey: "publish-one",
  label: "First review",
};
await assert.rejects(() =>
  api.publishAssembly(
    "owner",
    created.id,
    { ...publish, renderedAssetId: "short" },
    "http://studio.test",
  ),
);
const published = await api.publishAssembly(
  "owner",
  created.id,
  publish,
  "http://studio.test",
);
assert.equal(published.assembly.document.placements[0].in, 2);
await api.updateAssembly(
  "owner",
  created.id,
  {
    expectedRevision: 3,
    document: {
      ...assembly,
      placements: [{ ...assembly.placements[0], in: 1 }],
    },
  },
  "http://studio.test",
);
const retried = await api.publishAssembly(
  "owner",
  created.id,
  publish,
  "http://studio.test",
);
assert.equal(retried.id, published.id);
await assert.rejects(
  () =>
    api.publishAssembly(
      "owner",
      created.id,
      { ...publish, label: "Different" },
      "http://studio.test",
    ),
  (e: any) => e.code === "idempotency_conflict",
);
await assert.rejects(() =>
  api.publishAssembly(
    "owner",
    created.id,
    { ...publish, idempotencyKey: "stale" },
    "http://studio.test",
  ),
);
console.log(
  "PASS: bounds, immutable render binding, retry and stale publication",
);
const createRoute =
  await import("../../../studio/src/app/api/v1/productions/from-storyboard/route");
const draftRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/assembly/route");
const publishRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/publish/route");
const routeRequest = (method: string, token: string, body?: unknown) =>
  new Request("http://studio.test/api/v1/productions", {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
assert.equal(
  (await createRoute.POST(routeRequest("POST", "bad", {}))).status,
  401,
);
assert.equal(
  (
    await draftRoute.GET(routeRequest("GET", "other"), {
      params: Promise.resolve({ id: created.id }),
    })
  ).status,
  404,
);
const mediaLookup =
  await import("../../../studio/src/app/api/v1/productions/media/route");
const mediaUpload =
  await import("../../../studio/src/app/api/v1/productions/media/[sha256]/route");
const contentRoute =
  await import("../../../studio/src/app/api/v1/assets/[id]/content/route");
const oneRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/route");
const cutRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/cuts/[cutId]/route");
const threadRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/threads/route");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const route = new URL(req.url).pathname;
    if (route === "/api/v1/productions/from-storyboard")
      return createRoute.POST(req);
    if (route === "/api/v1/productions/media") return mediaLookup.GET(req);
    const upload = /^\/api\/v1\/productions\/media\/([^/]+)$/.exec(route);
    if (upload)
      return mediaUpload.PUT(req, {
        params: Promise.resolve({ sha256: upload[1]! }),
      });
    const content = /^\/api\/v1\/assets\/([^/]+)\/content$/.exec(route);
    if (content)
      return contentRoute.GET(req, {
        params: Promise.resolve({ id: content[1]! }),
      });
    const one = /^\/api\/v1\/productions\/([^/]+)$/.exec(route);
    if (one)
      return req.method === "GET"
        ? oneRoute.GET(req, { params: Promise.resolve({ id: one[1]! }) })
        : oneRoute.PATCH(req, { params: Promise.resolve({ id: one[1]! }) });
    if (route === "/api/v1/productions/from-storyboard")
      return createRoute.POST(req);
    const match = /^\/api\/v1\/productions\/([^/]+)\/(assembly|publish)$/.exec(
      route,
    );
    if (match) {
      const context = { params: Promise.resolve({ id: match[1]! }) };
      if (match[2] === "publish") return publishRoute.POST(req, context);
      return req.method === "GET"
        ? draftRoute.GET(req, context)
        : draftRoute.PUT(req, context);
    }
    return new Response("Not found", { status: 404 });
  },
});
async function cli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "src/bin.ts", "studio", "production", ...args, "--json"],
    {
      env: {
        ...process.env,
        MDMEDIA_STUDIO_URL: server.url.origin,
        MDMEDIA_API_KEY: "owner",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, out + err);
  return JSON.parse(out);
}
const directory = await mkdtemp(join(tmpdir(), "assembly-proof-"));
try {
  const made = await cli([
    "create",
    "--from-storyboard",
    "sb1",
    "--idempotency-key",
    "cli-create",
  ]);
  const exported = await cli(["assembly", "export", made.id]);
  assert.equal(exported.document.scenes[0].id, "intro");
  const source = join(directory, "source.mp4");
  const render = join(directory, "render.mp4");
  const voice = join(directory, "voice.wav");
  function runFFmpeg(args: string[]) {
    const result = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    assert.equal(result.exitCode, 0, result.stderr.toString());
  }
  runFFmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30",
    "-t",
    "5",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  runFFmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "4",
    voice,
  ]);
  const visual = await cli(["media", "add", source]);
  const audio = await cli(["media", "add", voice, "--type", "voice"]);
  const again = await cli(["media", "add", source]);
  assert.equal(again.id, visual.id);
  const edit = {
    ...exported.document,
    output: { width: 320, height: 180, fps: 30 },
    tracks: [
      { id: "screen", name: "Screen", type: "video" },
      { id: "pip", name: "Camera", type: "video" },
      { id: "narrator", name: "Narration", type: "audio" },
      { id: "music", name: "Music", type: "audio" },
      { id: "effects", name: "Effects", type: "audio" },
    ],
    placements: [
      {
        id: "bed",
        trackId: "music",
        assetId: audio.id,
        start: 0,
        in: 0,
        out: 4,
      },
      {
        id: "click",
        trackId: "effects",
        assetId: audio.id,
        start: 2.5,
        in: 0,
        out: 0.25,
      },
      {
        id: "main",
        trackId: "screen",
        assetId: visual.id,
        start: 0,
        in: 1,
        out: 5,
        sceneId: "intro",
      },
      {
        id: "inset",
        trackId: "pip",
        assetId: visual.id,
        start: 1,
        in: 0,
        out: 2,
        sceneId: "intro",
      },
      {
        id: "speech",
        trackId: "narrator",
        assetId: audio.id,
        start: 0,
        in: 0,
        out: 4,
        sceneId: "intro",
      },
    ],
  };
  const editFile = join(directory, "assembly.json");
  await writeFile(editFile, JSON.stringify(edit));
  assert.equal((await cli(["assembly", "check", editFile])).valid, true);
  const updated = await cli([
    "assembly",
    "update",
    made.id,
    "--file",
    editFile,
    "--expected-revision",
    "1",
  ]);
  assert.equal(updated.revision, 2);
  const downloaded = await cli([
    "assembly",
    "export",
    made.id,
    "--download-dir",
    join(directory, "media"),
  ]);
  assert(downloaded.files[visual.id]);
  await cli([
    "assembly",
    "export",
    made.id,
    "--download-dir",
    join(directory, "media"),
  ]);
  runFFmpeg([
    "-ss",
    "1",
    "-i",
    downloaded.files[visual.id],
    "-i",
    downloaded.files[visual.id],
    "-i",
    downloaded.files[audio.id],
    "-filter_complex",
    "[1:v]scale=80:45,setpts=PTS+1/TB[inset];[0:v][inset]overlay=10:10:enable=between(t\\,1\\,3)[v];[2:a]asplit=3[voice][music][effect];[music]volume=0.1[m];[effect]atrim=duration=0.25,adelay=2500|2500[e];[voice][m][e]amix=inputs=3:normalize=0[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    render,
  ]);
  const args = [
    "publish",
    made.id,
    "--render",
    render,
    "--expected-revision",
    "2",
    "--assembly-hash",
    updated.hash,
    "--idempotency-key",
    "render-one",
  ];
  const review = await cli(args);
  const retry = await cli(args);
  assert.equal(review.id, retry.id);
  assert.equal(review.kind, "assembly");
  await cli(["version", "approve", made.id, review.id]);
  await cli(["version", "select", made.id, review.id]);
  const detail = await cli(["show", made.id]);
  assert.equal(detail.approvedCutId, review.id);
  const context = {
    params: Promise.resolve({ id: made.id, cutId: review.id }),
  };
  assert.equal(
    (await cutRoute.DELETE(routeRequest("DELETE", "owner"), context)).status,
    409,
  );
  assert.equal(
    (
      await cutRoute.PUT(
        routeRequest("PUT", "owner", {
          label: "Overwrite",
          kind: "rendered",
          status: "review",
          order: 0,
          renderedAssetId: review.renderedAssetId,
        }),
        context,
      )
    ).status,
    409,
  );
  const comment = await threadRoute.POST(
    routeRequest("POST", "owner", {
      cutId: review.id,
      time: 1.5,
      text: "Tighten the pause",
      view: "16:9",
    }),
    { params: Promise.resolve({ id: made.id }) },
  );
  assert.equal(comment.status, 201, await comment.clone().text());
  const anchored = await comment.json();
  assert(anchored.anchor.items.some((i: { id: string }) => i.id === "inset"));
  // The agent removes the opening half-second across all tracks in one update.
  const ripple = {
    ...edit,
    placements: edit.placements.map((p) =>
      p.start >= 0.5
        ? { ...p, start: p.start - 0.5 }
        : { ...p, in: p.in + 0.5 },
    ),
  };
  await writeFile(editFile, JSON.stringify(ripple));
  const rippled = await cli([
    "assembly",
    "update",
    made.id,
    "--file",
    editFile,
    "--expected-revision",
    "2",
  ]);
  assert.deepEqual(
    rippled.document.placements.map((p: any) => p.id),
    edit.placements.map((p) => p.id),
  );
  const competing = await draftRoute.PUT(
    routeRequest("PUT", "owner", { expectedRevision: 2, document: edit }),
    { params: Promise.resolve({ id: made.id }) },
  );
  assert.equal(competing.status, 409);
  const unchanged = await (
    await cutRoute.GET(routeRequest("GET", "owner"), context)
  ).json();
  assert.equal(unchanged.renderedAssetId, review.renderedAssetId);
  assert.deepEqual(unchanged.assembly, review.assembly);
  assert.deepEqual(
    (
      await db
        .collection(`productions/${made.id}/threads`)
        .doc(anchored.id)
        .get()
    ).data().anchor,
    anchored.anchor,
  );

  console.log(
    "PASS: real CLI uploads, multitrack assembly, download reuse, external FFmpeg render, publication, approval, immutable versions and anchored review",
  );
} finally {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}

const watchRoute =
  await import("../../../studio/src/app/api/v1/productions/[id]/comments/watch/route");
const ac = new AbortController();
const stream = await watchRoute.GET(
  new Request(
    `http://studio.test/api/v1/productions/${created.id}/comments/watch`,
    { headers: { Authorization: "Bearer owner" }, signal: ac.signal },
  ),
  { params: Promise.resolve({ id: created.id }) },
);
assert.equal(stream.status, 200);
const reader = stream.body!.getReader();
const first = new TextDecoder().decode((await reader.read()).value);
assert(first.includes("event: snapshot"));
await db
  .collection(`productions/${created.id}/threads`)
  .doc("thread1")
  .set({
    ownerUid: "owner",
    version: { cutId: published.id },
    text: "Tighten this",
    updatedAt: 10,
  });
const change = new TextDecoder().decode((await reader.read()).value);
assert(change.includes("Tighten this"));
assert(change.includes("event: change"));
ac.abort();
await reader.cancel();
assert.equal(watchers.size, 0);
console.log(
  "PASS: authenticated review stream initial snapshot, changes and listener cleanup",
);

// Reconnection is observed through the actual long-running CLI process.
let connections = 0;
const reconnectServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const context = { params: Promise.resolve({ id: created.id }) };
    if (new URL(req.url).pathname.endsWith("/comments/watch")) {
      const response = await watchRoute.GET(req, context);
      connections++;
      if (connections === 1) {
        const source = response.body!.getReader();
        return new Response(
          new ReadableStream({
            async start(controller) {
              const first = await source.read();
              controller.enqueue(first.value);
              controller.close();
              await source.cancel();
            },
          }),
          { headers: response.headers },
        );
      }
      return response;
    }
    return oneRoute.GET(req, context);
  },
});
const watching = Bun.spawn(
  [process.execPath, "src/bin.ts", "comments", "watch", created.id],
  {
    env: {
      ...process.env,
      MDMEDIA_STUDIO_URL: reconnectServer.url.origin,
      MDMEDIA_API_KEY: "owner",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const output = watching.stdout.getReader();
let text = "";
const timeout = setTimeout(() => watching.kill(), 10000);
try {
  while (text.split('"event":"snapshot"').length - 1 < 2) {
    const next = await output.read();
    assert(!next.done, "watch exited before reconnect");
    text += new TextDecoder().decode(next.value);
  }
  const request = new Request(
    `http://studio.test/api/v1/productions/${created.id}/threads`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cutId: published.id,
        time: 1,
        text: "A new browser review",
      }),
    },
  );
  assert.equal(
    (
      await threadRoute.POST(request, {
        params: Promise.resolve({ id: created.id }),
      })
    ).status,
    201,
  );
  while (!text.includes("A new browser review")) {
    const next = await output.read();
    assert(!next.done);
    text += new TextDecoder().decode(next.value);
  }
  watching.kill("SIGINT");
  assert.equal(await watching.exited, 0);
  assert(connections >= 2);
  console.log(
    "PASS: CLI watch reconnects with a fresh snapshot and receives a new review",
  );
} finally {
  clearTimeout(timeout);
  watching.kill();
  await output.cancel().catch(() => {});
  reconnectServer.stop(true);
}

const unavailable = await api.assemblyApi(async () => {
  throw new Error("test database interruption");
});
assert.equal(unavailable.status, 500);
assert.equal((await unavailable.json()).error.code, "productions_unavailable");
console.log("PASS: assembly infrastructure failures have stable API errors");
