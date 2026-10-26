import { defineCommand, type ArgsDef, type CommandDef } from "citty";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AssemblyError,
  parseAssembly,
  assemblyDuration,
} from "../assembly/index.js";
import {
  StudioApiError,
  type StudioClient,
  type ProductionMediaType,
} from "../remote/client.js";
import { sha256OfFile, durationMsOf } from "../production/probe.js";
import { mimeTypeOf, mediaTypeOf } from "../production/sources.js";
import { connectedClient, guarded } from "./studio-support.js";
const json = { type: "boolean", description: "Print JSON" } as const;
const id = {
  type: "positional",
  required: true,
  description: "Production ID",
} as const;
const file = {
  type: "string",
  required: true,
  description: "Assembly JSON file",
} as const;
const revision = {
  type: "string",
  required: true,
  description: "Expected draft revision",
} as const;
const token = {
  type: "string",
  required: true,
  description: "Stable key to reuse when retrying this operation",
} as const;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
function action<T extends ArgsDef>(
  definition: CommandDef<T> & {
    args: T;
    run: NonNullable<CommandDef<T>["run"]>;
  },
) {
  return defineCommand({
    ...definition,
    async run(context) {
      await guarded(context.args.json === true, async () => {
        const allowed = new Set([
          "_",
          ...Object.keys(definition.args).flatMap((k) => [
            k,
            k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
          ]),
        ]);
        for (const k of Object.keys(context.args))
          if (!allowed.has(k))
            throw new StudioApiError(
              400,
              "unknown_option",
              `Unknown option --${k}.`,
            );
        try {
          await definition.run(context);
        } catch (e) {
          if (e instanceof AssemblyError)
            throw new StudioApiError(422, e.code, e.message);
          throw e;
        }
      });
    },
  });
}
function expected(raw: string) {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new StudioApiError(
      400,
      "invalid_revision",
      "Expected a positive integer revision.",
    );
  return Number(raw);
}
async function readDocument(file: string) {
  let data: unknown;
  try {
    data = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    throw new StudioApiError(
      400,
      "invalid_assembly",
      "Cannot read assembly JSON.",
    );
  }
  return parseAssembly(
    data && typeof data === "object" && "document" in data
      ? (data as { document: unknown }).document
      : data,
  );
}
async function upload(client: StudioClient, file: string, type?: string) {
  const mimeType = mimeTypeOf(file);
  if (!mimeType)
    throw new StudioApiError(
      400,
      "unsupported_media",
      "Unsupported media file.",
    );
  const mediaType = type ?? mediaTypeOf(file, "segment");
  if (!["video", "image", "voice", "music", "sfx"].includes(mediaType))
    throw new StudioApiError(400, "invalid_type", "Invalid media type.");
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw new StudioApiError(
      400,
      "invalid_upload",
      "Provide a media file of at most 256 MiB.",
    );
  const sha256 = await sha256OfFile(file);
  const found = await client.findProductionMedia([sha256]);
  if (found.has(sha256)) return found.get(sha256)!;
  const durationMs = await durationMsOf(file, mimeType);
  const body =
    typeof fs.openAsBlob === "function"
      ? await fs.openAsBlob(file)
      : new Blob([new Uint8Array(await fs.promises.readFile(file))]);
  return client.uploadProductionMedia({
    sha256,
    mediaType: mediaType as ProductionMediaType,
    mimeType,
    byteLength: stat.size,
    body,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}
const list = action({
  meta: { name: "list", description: "List productions" },
  args: { json },
  async run() {
    print(await connectedClient().productions());
  },
});
const show = action({
  meta: { name: "show", description: "Inspect a production and its assembly" },
  args: { id, json },
  async run({ args }) {
    const client = connectedClient();
    const production = await client.production(args.id);
    print({
      ...production,
      ...(production.assemblyManaged
        ? { assembly: await client.assembly(args.id) }
        : {}),
    });
  },
});
const create = action({
  meta: {
    name: "create",
    description: "Create a production from an independent storyboard",
  },
  args: {
    "from-storyboard": { type: "string", required: true },
    title: { type: "string" },
    "idempotency-key": token,
    json,
  },
  async run({ args }) {
    print(
      await connectedClient().createAssemblyProduction({
        storyboardId: args["from-storyboard"],
        idempotencyKey: args["idempotency-key"],
        ...(args.title ? { title: args.title } : {}),
      }),
    );
  },
});
const add = action({
  meta: { name: "add", description: "Register local media" },
  args: {
    file: { type: "positional", required: true },
    type: { type: "string" },
    json,
  },
  async run({ args }) {
    print(await upload(connectedClient(), args.file, args.type));
  },
});
const check = action({
  meta: { name: "check", description: "Validate an assembly locally" },
  args: { file: { type: "positional", required: true }, json },
  async run({ args }) {
    const document = await readDocument(args.file);
    print({ valid: true, duration: assemblyDuration(document) });
  },
});
const update = action({
  meta: { name: "update", description: "Atomically replace the draft" },
  args: { id, file, "expected-revision": revision, json },
  async run({ args }) {
    const expectedRevision = expected(args["expected-revision"]);
    const document = await readDocument(args.file);
    print(
      await connectedClient().updateAssembly(args.id, {
        expectedRevision,
        document,
      }),
    );
  },
});
const exportAssembly = action({
  meta: {
    name: "export",
    description:
      "Export the current assembly and optionally download its sources",
  },
  args: {
    id,
    out: { type: "string" },
    "download-dir": { type: "string" },
    json,
  },
  async run({ args }) {
    const client = connectedClient();
    const result = await client.assembly(args.id);
    const files: Record<string, string> = {};
    if (args["download-dir"]) {
      const dir = path.resolve(args["download-dir"]);
      await fs.promises.mkdir(dir, { recursive: true });
      for (const asset of Object.values(result.assets)) {
        const target = path.join(dir, asset.id);
        files[asset.id] = target;
        if (
          fs.existsSync(target) &&
          asset.sha256 &&
          (await sha256OfFile(target)) === asset.sha256
        )
          continue;
        if (fs.existsSync(target))
          throw new StudioApiError(
            409,
            "local_media_conflict",
            `Existing file differs: ${target}`,
          );
        const temp = `${target}.${process.pid}.part`;
        try {
          const download = await client.downloadAsset(asset.links.content);
          await pipeline(
            Readable.fromWeb(
              download.body as unknown as import("node:stream/web").ReadableStream,
            ),
            fs.createWriteStream(temp, { flags: "wx" }),
          );
          if (asset.sha256 && (await sha256OfFile(temp)) !== asset.sha256)
            throw new StudioApiError(
              422,
              "media_hash_mismatch",
              "Downloaded media hash differs.",
            );
          await fs.promises.link(temp, target);
        } finally {
          await fs.promises.rm(temp, { force: true });
        }
      }
    }
    const exported = { ...result, ...(args["download-dir"] ? { files } : {}) };
    if (args.out)
      await fs.promises.writeFile(
        args.out,
        JSON.stringify(exported, null, 2) + "\n",
      );
    print(exported);
  },
});
const publish = action({
  meta: {
    name: "publish",
    description: "Publish an immutable assembly and its external render",
  },
  args: {
    id,
    render: { type: "string", required: true },
    "expected-revision": revision,
    "assembly-hash": { type: "string", required: true },
    "idempotency-key": token,
    label: { type: "string" },
    json,
  },
  async run({ args }) {
    const expectedRevision = expected(args["expected-revision"]);
    if (!/^[a-f0-9]{64}$/.test(args["assembly-hash"]))
      throw new StudioApiError(400, "invalid_hash", "Invalid assembly hash.");
    const client = connectedClient();
    const render = await upload(client, args.render, "video");
    print(
      await client.publishAssembly(args.id, {
        expectedRevision,
        assemblyHash: args["assembly-hash"],
        renderedAssetId: render.id,
        idempotencyKey: args["idempotency-key"],
        ...(args.label ? { label: args.label } : {}),
      }),
    );
  },
});
const versionArgs = {
  id,
  version: { type: "positional", required: true },
  json,
} as const;
const select = action({
  meta: { name: "select", description: "Select the current review version" },
  args: versionArgs,
  async run({ args }) {
    print(
      await connectedClient().updateProduction(args.id, {
        currentCutId: args.version,
      }),
    );
  },
});
const approve = action({
  meta: { name: "approve", description: "Approve a review version" },
  args: versionArgs,
  async run({ args }) {
    print(
      await connectedClient().updateProduction(args.id, {
        approvedCutId: args.version,
        cuts: [{ id: args.version, status: "approved" }],
      }),
    );
  },
});
export const studioProductionCommand = defineCommand({
  meta: {
    name: "production",
    description: "Organize and assemble Studio productions",
  },
  subCommands: {
    list,
    show,
    create,
    media: defineCommand({ meta: { name: "media" }, subCommands: { add } }),
    assembly: defineCommand({
      meta: { name: "assembly" },
      subCommands: { export: exportAssembly, check, update },
    }),
    publish,
    version: defineCommand({
      meta: { name: "version" },
      subCommands: { select, approve },
    }),
  },
});
