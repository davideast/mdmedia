import { resolvePrivateMediaContentPath } from "../components/reader/document-media-card";
import { parseMediaUri } from "./markdown-word-aligner";
import type { TreeMediaRef } from "./tree-types";

export interface ZipEntryInput {
  /** Normalized relative path inside the archive, e.g. "my-doc/images/fig-1.png" */
  path: string;
  data: Uint8Array | string;
  mtime?: Date;
}

export interface FetchedMediaPayload {
  bytes: Uint8Array;
  mimeType: string;
}

export interface HermeticMediaAssetEntry {
  key: string;
  mediaRef: TreeMediaRef;
  contentPath: string;
  archiveRelativePath: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface BuildHermeticDocumentOptions {
  title: string;
  markdown: string;
  docPath?: string;
  pathAssets?: Record<string, TreeMediaRef>;
  fetchMedia: (contentPath: string, mediaRef: TreeMediaRef) => Promise<FetchedMediaPayload>;
  now?: Date;
}

export interface HermeticDocumentPackage {
  zipBytes: Uint8Array;
  zipFilename: string;
  folderName: string;
  markdownFilename: string;
  rewrittenMarkdown: string;
  mediaAssets: HermeticMediaAssetEntry[];
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a standard PKZIP archive (ZIP 2.0 STORE method with UTF-8 paths and CRC-32 checksums).
 * Suitable for packaging Markdown files alongside pre-compressed PNG/JPEG/WebP/MP4/MP3 media.
 */
export function createZipArchive(entries: ReadonlyArray<ZipEntryInput>): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const normalizedPath = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const pathBytes = encoder.encode(normalizedPath);
    const dataBytes =
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const checksum = crc32(dataBytes);
    const { dosTime, dosDate } = toDosDateTime(entry.mtime ?? new Date());
    return {
      pathBytes,
      dataBytes,
      checksum,
      dosTime,
      dosDate,
    };
  });

  let localHeadersAndDataSize = 0;
  let centralDirectorySize = 0;
  for (const item of prepared) {
    localHeadersAndDataSize += 30 + item.pathBytes.length + item.dataBytes.length;
    centralDirectorySize += 46 + item.pathBytes.length;
  }

  const totalSize = localHeadersAndDataSize + centralDirectorySize + 22;
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);

  let offset = 0;
  const localHeaderOffsets: number[] = [];

  for (const item of prepared) {
    localHeaderOffsets.push(offset);
    // Local file header signature (0x04034b50)
    view.setUint32(offset, 0x04034b50, true);
    // Version needed to extract (2.0 = 20)
    view.setUint16(offset + 4, 20, true);
    // General purpose bit flag (0x0800 = UTF-8 filename)
    view.setUint16(offset + 6, 0x0800, true);
    // Compression method (0 = STORE)
    view.setUint16(offset + 8, 0, true);
    // Last mod file time & date
    view.setUint16(offset + 10, item.dosTime, true);
    view.setUint16(offset + 12, item.dosDate, true);
    // CRC-32
    view.setUint32(offset + 14, item.checksum, true);
    // Compressed & uncompressed sizes
    view.setUint32(offset + 18, item.dataBytes.length, true);
    view.setUint32(offset + 22, item.dataBytes.length, true);
    // File name length & extra field length
    view.setUint16(offset + 26, item.pathBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;

    output.set(item.pathBytes, offset);
    offset += item.pathBytes.length;

    output.set(item.dataBytes, offset);
    offset += item.dataBytes.length;
  }

  const centralDirectoryOffset = offset;

  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]!;
    const localOffset = localHeaderOffsets[i]!;
    // Central directory file header signature (0x02014b50)
    view.setUint32(offset, 0x02014b50, true);
    // Version made by (20) & version needed to extract (20)
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    // General purpose bit flag (0x0800 = UTF-8)
    view.setUint16(offset + 8, 0x0800, true);
    // Compression method (0 = STORE)
    view.setUint16(offset + 10, 0, true);
    // Last mod file time & date
    view.setUint16(offset + 12, item.dosTime, true);
    view.setUint16(offset + 14, item.dosDate, true);
    // CRC-32
    view.setUint32(offset + 16, item.checksum, true);
    // Compressed & uncompressed sizes
    view.setUint32(offset + 20, item.dataBytes.length, true);
    view.setUint32(offset + 24, item.dataBytes.length, true);
    // File name length, extra field length, file comment length
    view.setUint16(offset + 28, item.pathBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    // Disk number start, internal/external file attributes
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    // Relative offset of local header
    view.setUint32(offset + 42, localOffset, true);
    offset += 46;

    output.set(item.pathBytes, offset);
    offset += item.pathBytes.length;
  }

  // End of central directory record (0x06054b50)
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralDirectorySize, true);
  view.setUint32(offset + 16, centralDirectoryOffset, true);
  view.setUint16(offset + 20, 0, true);

  return output;
}

export function slugifyExportName(raw: string, fallback = "document"): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

export function deriveExportSlug(input: {
  docPath?: string | null;
  title?: string | null;
  fallback?: string;
}): string {
  const { docPath, title, fallback = "document" } = input;
  if (docPath) {
    const parts = docPath
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    if (last && last.toLowerCase() !== "index.md") {
      const fromFile = slugifyExportName(last, "");
      if (fromFile) return fromFile;
    } else if (parts.length >= 2) {
      const parentFolder = parts[parts.length - 2] ?? "";
      const fromFolder = slugifyExportName(parentFolder, "");
      if (fromFolder) return fromFolder;
    }
  }
  if (title) {
    const fromTitle = slugifyExportName(title, "");
    if (fromTitle) return fromTitle;
  }
  return fallback;
}

export function extensionForMimeType(mimeType: string, fallbackExt = "png"): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (normalized) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    default:
      return fallbackExt;
  }
}

function parseDirectAssetContentHref(rawHref: string): TreeMediaRef | null {
  const match = /^\/api\/v1\/assets\/([^/?#]+)\/content/i.exec(rawHref.trim());
  if (!match?.[1]) return null;
  return { type: "asset", id: decodeURIComponent(match[1]) };
}

function deriveMediaBaseFilename(
  rawHref: string,
  altOrLabel: string,
  mediaRef: TreeMediaRef,
  index: number,
): { baseName: string; fallbackExt: string } {
  const trimmedHref = rawHref.trim().split(/[?#]/)[0] ?? "";
  if (!trimmedHref.toLowerCase().startsWith("mdmedia://") && !trimmedHref.startsWith("/api/")) {
    const filePart = trimmedHref.split("/").pop() ?? "";
    const dotIdx = filePart.lastIndexOf(".");
    if (dotIdx > 0) {
      const namePart = slugifyExportName(filePart.slice(0, dotIdx), "");
      const extPart = filePart.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (namePart && extPart) {
        return { baseName: namePart, fallbackExt: extPart };
      }
    }
  }

  const prefix = String(index).padStart(2, "0");
  const normalizedAlt = altOrLabel.trim();
  const isGenericAlt = /^(media|image|video|audio|asset|photo|figure|untitled)$/i.test(
    normalizedAlt,
  );
  const altSlug = !isGenericAlt ? slugifyExportName(normalizedAlt, "") : "";
  const shortId = (mediaRef.generationId ?? mediaRef.id)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8);
  const fallbackExt =
    mediaRef.type === "video"
      ? "mp4"
      : mediaRef.type === "music" || mediaRef.type === "sfx" || mediaRef.type === "narration"
        ? "mp3"
        : "png";

  const baseName = altSlug
    ? `${prefix}-${altSlug}`
    : `${prefix}-${mediaRef.type}-${shortId || index}`;
  return { baseName, fallbackExt };
}

interface DiscoveredMarkdownMediaOccurrence {
  fullMatch: string;
  isImageSyntax: boolean;
  label: string;
  rawHref: string;
  mediaRef: TreeMediaRef;
  contentPath: string;
  key: string;
}

/**
 * Finds all embedded Studio media references (`![alt](mdmedia://...)`, `[label](mdmedia://...)`,
 * or relative asset paths bound in `pathAssets`) outside fenced code blocks, fetches their binary
 * content, rewrites the Markdown links to hermetic relative paths (`./images/...` or `./media/...`),
 * and packages everything into a single `.zip` archive.
 */
export async function buildHermeticDocumentPackage(
  options: BuildHermeticDocumentOptions,
): Promise<HermeticDocumentPackage> {
  const { title, markdown, docPath, pathAssets, fetchMedia, now = new Date() } = options;

  const folderName = deriveExportSlug({ docPath, title });
  const rawDocFile = docPath?.split("/").pop() ?? "";
  const markdownFilename =
    rawDocFile && rawDocFile.toLowerCase() !== "index.md" && rawDocFile.endsWith(".md")
      ? rawDocFile
      : `${folderName}.md`;

  // Split markdown by fenced code blocks so we never rewrite links inside ```...``` fences
  const fenceRegex = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/gm;
  const segments: Array<{ text: string; isFence: boolean }> = [];
  let lastIndex = 0;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(markdown)) !== null) {
    if (fenceMatch.index > lastIndex) {
      segments.push({ text: markdown.slice(lastIndex, fenceMatch.index), isFence: false });
    }
    segments.push({ text: fenceMatch[0], isFence: true });
    lastIndex = fenceMatch.index + fenceMatch[0].length;
  }
  if (lastIndex < markdown.length) {
    segments.push({ text: markdown.slice(lastIndex), isFence: false });
  }

  const linkRegex = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const occurrencesByKey = new Map<string, DiscoveredMarkdownMediaOccurrence>();

  for (const segment of segments) {
    if (segment.isFence) continue;
    let match: RegExpExecArray | null;
    linkRegex.lastIndex = 0;
    while ((match = linkRegex.exec(segment.text)) !== null) {
      const isImageSyntax = match[1] === "!";
      const label = match[2] ?? "";
      const rawHref = match[3] ?? "";
      const mediaRef =
        parseMediaUri(rawHref, pathAssets, docPath) ?? parseDirectAssetContentHref(rawHref);
      if (!mediaRef || mediaRef.type === "mermaid" || mediaRef.type === "text") {
        continue;
      }
      const contentPath = resolvePrivateMediaContentPath(mediaRef);
      if (!contentPath) continue;

      const key = `${mediaRef.type}:${mediaRef.id}:${mediaRef.generationId ?? ""}`;
      if (!occurrencesByKey.has(key)) {
        occurrencesByKey.set(key, {
          fullMatch: match[0],
          isImageSyntax,
          label,
          rawHref,
          mediaRef,
          contentPath,
          key,
        });
      }
    }
  }

  const mediaAssets: HermeticMediaAssetEntry[] = [];
  const relativePathByKey = new Map<string, string>();
  const usedArchivePaths = new Set<string>();

  let index = 1;
  for (const item of occurrencesByKey.values()) {
    const payload = await fetchMedia(item.contentPath, item.mediaRef);
    const { baseName, fallbackExt } = deriveMediaBaseFilename(
      item.rawHref,
      item.label,
      item.mediaRef,
      index,
    );
    const ext = extensionForMimeType(payload.mimeType, fallbackExt);
    const subdir =
      item.mediaRef.type === "image" || item.mediaRef.type === "asset" ? "images" : "media";

    let candidateRelPath = `${subdir}/${baseName}.${ext}`;
    let collisionCounter = 2;
    while (usedArchivePaths.has(candidateRelPath)) {
      candidateRelPath = `${subdir}/${baseName}-${collisionCounter}.${ext}`;
      collisionCounter += 1;
    }
    usedArchivePaths.add(candidateRelPath);

    relativePathByKey.set(item.key, `./${candidateRelPath}`);
    mediaAssets.push({
      key: item.key,
      mediaRef: item.mediaRef,
      contentPath: item.contentPath,
      archiveRelativePath: candidateRelPath,
      bytes: payload.bytes,
      mimeType: payload.mimeType,
    });
    index += 1;
  }

  // Rewrite markdown links outside code fences to point to ./images/... or ./media/...
  const rewrittenMarkdown = segments
    .map((segment) => {
      if (segment.isFence) return segment.text;
      return segment.text.replace(linkRegex, (full, bang: string, label: string, rawHref: string) => {
        const mediaRef =
          parseMediaUri(rawHref, pathAssets, docPath) ?? parseDirectAssetContentHref(rawHref);
        if (!mediaRef || mediaRef.type === "mermaid" || mediaRef.type === "text") {
          return full;
        }
        const key = `${mediaRef.type}:${mediaRef.id}:${mediaRef.generationId ?? ""}`;
        const localRelPath = relativePathByKey.get(key);
        if (!localRelPath) return full;
        const prefix =
          bang === "!" || mediaRef.type === "image" || mediaRef.type === "asset" ? "!" : "";
        return `${prefix}[${label}](${localRelPath})`;
      });
    })
    .join("");

  const zipEntries: ZipEntryInput[] = [
    {
      path: `${folderName}/${markdownFilename}`,
      data: rewrittenMarkdown,
      mtime: now,
    },
    ...mediaAssets.map((asset) => ({
      path: `${folderName}/${asset.archiveRelativePath}`,
      data: asset.bytes,
      mtime: now,
    })),
  ];

  const zipBytes = createZipArchive(zipEntries);
  return {
    zipBytes,
    zipFilename: `${folderName}.zip`,
    folderName,
    markdownFilename,
    rewrittenMarkdown,
    mediaAssets,
  };
}
