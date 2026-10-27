import { lexer, type Token, type Tokens } from "marked";
import { resolvePrivateMediaContentPath } from "../components/reader/document-media-card";
import {
  createZipArchive,
  deriveExportSlug,
  extensionForMimeType,
  type BuildHermeticDocumentOptions,
  type HermeticMediaAssetEntry,
  type ZipEntryInput,
} from "./hermetic-export";
import { parseMediaUri } from "./markdown-word-aligner";
import type { TreeMediaRef } from "./tree-types";

export interface DocxDocumentPackage {
  docxBytes: Uint8Array;
  docxFilename: string;
  slug: string;
  mediaAssets: HermeticMediaAssetEntry[];
}

const EMU_PER_PIXEL = 9525;
const MAX_IMAGE_WIDTH_PX = 624; // 6.5 inches at 96 DPI
const MAX_IMAGE_HEIGHT_PX = 720; // 7.5 inches at 96 DPI

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Inspects binary PNG, JPEG, or WebP headers to extract pixel dimensions without DOM or native bindings.
 */
export function readImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } {
  // PNG: 8-byte signature followed by IHDR chunk with 4-byte big-endian width & height at offset 16..24
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG: scan markers for SOF0..SOF3 / SOF5..SOF15
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2, false);
      if (length < 2) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 9 <= bytes.length) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + length;
    }
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunkType = String.fromCharCode(
      bytes[12]!,
      bytes[13]!,
      bytes[14]!,
      bytes[15]!,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (chunkType === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkType === "VP8 " && bytes.length >= 30) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkType === "VP8L" && bytes.length >= 25) {
      const bits = view.getUint32(21, true);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { width, height };
    }
  }

  return { width: 600, height: 380 };
}

function computeImageEmuSize(bytes: Uint8Array): { cx: number; cy: number } {
  const { width, height } = readImageDimensions(bytes);
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH_PX / Math.max(1, width),
    MAX_IMAGE_HEIGHT_PX / Math.max(1, height),
  );
  const scaledW = Math.max(48, Math.round(width * scale));
  const scaledH = Math.max(48, Math.round(height * scale));
  return {
    cx: scaledW * EMU_PER_PIXEL,
    cy: scaledH * EMU_PER_PIXEL,
  };
}

function parseDirectAssetContentHref(rawHref: string): TreeMediaRef | null {
  const match = /^\/api\/v1\/assets\/([^/?#]+)\/content/i.exec(rawHref.trim());
  if (!match?.[1]) return null;
  return { type: "asset", id: decodeURIComponent(match[1]) };
}

interface DocxBuildContext {
  docPath?: string;
  pathAssets?: Record<string, TreeMediaRef>;
  imageRIdByKey: Map<string, { rId: string; cx: number; cy: number; name: string }>;
  hyperlinks: Array<{ rId: string; target: string }>;
  nextDrawingId: () => number;
  registerHyperlink: (url: string) => string;
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  underline?: boolean;
}

function buildRunPrXml(style: RunStyle): string {
  const parts: string[] = [];
  if (style.code) {
    parts.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    parts.push('<w:sz w:val="20"/><w:szCs w:val="20"/>');
    parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>');
  }
  if (style.bold) parts.push("<w:b/>");
  if (style.italic) parts.push("<w:i/>");
  if (style.strike) parts.push("<w:strike/>");
  if (style.underline) parts.push('<w:u w:val="single"/>');
  if (style.color) parts.push(`<w:color w:val="${style.color}"/>`);
  return parts.length > 0 ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function buildTextRunXml(text: string, style: RunStyle = {}): string {
  if (!text) return "";
  const lines = text.split("\n");
  const rPr = buildRunPrXml(style);
  const inner = lines
    .map((line, idx) => {
      const escaped = escapeXml(line);
      const tNode = `<w:t xml:space="preserve">${escaped}</w:t>`;
      return idx === 0 ? tNode : `<w:br/>${tNode}`;
    })
    .join("");
  return `<w:r>${rPr}${inner}</w:r>`;
}

function buildImageDrawingRunXml(
  rId: string,
  cx: number,
  cy: number,
  drawingId: number,
  label: string,
): string {
  const safeName = escapeXml(label || `Image ${drawingId}`);
  return [
    "<w:r>",
    "<w:drawing>",
    '<wp:inline distT="0" distB="0" distL="0" distR="0">',
    `<wp:extent cx="${cx}" cy="${cy}"/>`,
    `<wp:docPr id="${drawingId}" name="${safeName}" descr="${safeName}"/>`,
    "<wp:cNvGraphicFramePr>",
    '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>',
    "</wp:cNvGraphicFramePr>",
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    "<pic:nvPicPr>",
    `<pic:cNvPr id="${drawingId}" name="${safeName}"/>`,
    "<pic:cNvPicPr/>",
    "</pic:nvPicPr>",
    "<pic:blipFill>",
    `<a:blip r:embed="${rId}"/>`,
    "<a:stretch><a:fillRect/></a:stretch>",
    "</pic:blipFill>",
    "<pic:spPr>",
    "<a:xfrm>",
    '<a:off x="0" y="0"/>',
    `<a:ext cx="${cx}" cy="${cy}"/>`,
    "</a:xfrm>",
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    "</pic:spPr>",
    "</pic:pic>",
    "</a:graphicData>",
    "</a:graphic>",
    "</wp:inline>",
    "</w:drawing>",
    "</w:r>",
  ].join("");
}

function renderInlineTokensToXml(
  tokens: readonly Token[] | undefined,
  ctx: DocxBuildContext,
  style: RunStyle = {},
): string {
  if (!tokens || tokens.length === 0) return "";
  const out: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const t = token as Tokens.Text;
        if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
          out.push(renderInlineTokensToXml(t.tokens, ctx, style));
        } else {
          out.push(buildTextRunXml(t.text, style));
        }
        break;
      }
      case "strong": {
        const t = token as Tokens.Strong;
        out.push(renderInlineTokensToXml(t.tokens, ctx, { ...style, bold: true }));
        break;
      }
      case "em": {
        const t = token as Tokens.Em;
        out.push(renderInlineTokensToXml(t.tokens, ctx, { ...style, italic: true }));
        break;
      }
      case "del": {
        const t = token as Tokens.Del;
        out.push(renderInlineTokensToXml(t.tokens, ctx, { ...style, strike: true }));
        break;
      }
      case "codespan": {
        const t = token as Tokens.Codespan;
        out.push(buildTextRunXml(t.text, { ...style, code: true }));
        break;
      }
      case "br": {
        out.push("<w:r><w:br/></w:r>");
        break;
      }
      case "image": {
        const t = token as Tokens.Image;
        const mediaRef =
          parseMediaUri(t.href, ctx.pathAssets, ctx.docPath) ??
          parseDirectAssetContentHref(t.href);
        if (mediaRef) {
          const key = `${mediaRef.type}:${mediaRef.id}:${mediaRef.generationId ?? ""}`;
          const info = ctx.imageRIdByKey.get(key);
          if (info) {
            out.push(
              buildImageDrawingRunXml(
                info.rId,
                info.cx,
                info.cy,
                ctx.nextDrawingId(),
                t.text || info.name,
              ),
            );
            break;
          }
        }
        out.push(buildTextRunXml(t.text ? `[Image: ${t.text}]` : "[Image]", { ...style, italic: true }));
        break;
      }
      case "link": {
        const t = token as Tokens.Link;
        const mediaRef =
          parseMediaUri(t.href, ctx.pathAssets, ctx.docPath) ??
          parseDirectAssetContentHref(t.href);
        if (mediaRef) {
          const key = `${mediaRef.type}:${mediaRef.id}:${mediaRef.generationId ?? ""}`;
          const info = ctx.imageRIdByKey.get(key);
          if (info) {
            out.push(
              buildImageDrawingRunXml(
                info.rId,
                info.cx,
                info.cy,
                ctx.nextDrawingId(),
                t.text || info.name,
              ),
            );
            break;
          }
        }
        if (/^https?:\/\/|^mailto:/i.test(t.href.trim())) {
          const rId = ctx.registerHyperlink(t.href.trim());
          const innerRuns = renderInlineTokensToXml(t.tokens, ctx, {
            ...style,
            color: "2563EB",
            underline: true,
          });
          out.push(`<w:hyperlink r:id="${rId}">${innerRuns}</w:hyperlink>`);
        } else {
          out.push(
            renderInlineTokensToXml(t.tokens, ctx, {
              ...style,
              color: "2563EB",
              underline: true,
            }),
          );
        }
        break;
      }
      default: {
        const rawText = "text" in token && typeof token.text === "string" ? token.text : "";
        if (rawText) {
          out.push(buildTextRunXml(rawText, style));
        }
        break;
      }
    }
  }

  return out.join("");
}

function renderBlockTokensToXml(
  tokens: readonly Token[],
  ctx: DocxBuildContext,
): string {
  const blocks: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const h = token as Tokens.Heading;
        const level = Math.max(1, Math.min(6, h.depth));
        const runs = renderInlineTokensToXml(h.tokens, ctx);
        blocks.push(
          `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${runs}</w:p>`,
        );
        break;
      }
      case "paragraph": {
        const p = token as Tokens.Paragraph;
        const runs = renderInlineTokensToXml(p.tokens, ctx);
        blocks.push(`<w:p>${runs}</w:p>`);
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        const codeLines = c.text.replace(/\n$/, "").split("\n");
        const runs = codeLines
          .map((line, idx) => {
            const prefix = idx > 0 ? "<w:br/>" : "";
            return `<w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>${prefix}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
          })
          .join("");
        blocks.push(
          `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:ind w:left="240" w:right="240"/><w:spacing w:before="120" w:after="120"/></w:pPr>${runs}</w:p>`,
        );
        break;
      }
      case "blockquote": {
        const bq = token as Tokens.Blockquote;
        for (const sub of bq.tokens) {
          if (sub.type === "paragraph") {
            const p = sub as Tokens.Paragraph;
            const runs = renderInlineTokensToXml(p.tokens, ctx, { italic: true, color: "4B5563" });
            blocks.push(
              `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="D1D5DB"/></w:pBdr><w:ind w:left="360"/></w:pPr>${runs}</w:p>`,
            );
          } else {
            blocks.push(renderBlockTokensToXml([sub], ctx));
          }
        }
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const prefix = list.ordered ? `${(Number(list.start) || 1) + index}. ` : "• ";
          const itemInlineTokens: Token[] = [];
          const nestedBlocks: Token[] = [];
          for (const child of item.tokens) {
            if (child.type === "text" && "tokens" in child && Array.isArray(child.tokens)) {
              itemInlineTokens.push(...child.tokens);
            } else if (child.type === "paragraph" && "tokens" in child && Array.isArray(child.tokens)) {
              itemInlineTokens.push(...child.tokens);
            } else if (child.type === "list") {
              nestedBlocks.push(child);
            } else {
              itemInlineTokens.push(child);
            }
          }
          const runs =
            buildTextRunXml(prefix, { bold: list.ordered }) +
            renderInlineTokensToXml(itemInlineTokens, ctx);
          blocks.push(
            `<w:p><w:pPr><w:ind w:left="480" w:hanging="240"/><w:spacing w:before="40" w:after="40"/></w:pPr>${runs}</w:p>`,
          );
          if (nestedBlocks.length > 0) {
            blocks.push(renderBlockTokensToXml(nestedBlocks, ctx));
          }
        });
        break;
      }
      case "table": {
        const tbl = token as Tokens.Table;
        const headerCells = tbl.header
          .map((cell) => {
            const runs = renderInlineTokensToXml(cell.tokens, ctx, { bold: true });
            return `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:tcPr><w:p>${runs}</w:p></w:tc>`;
          })
          .join("");
        const bodyRows = tbl.rows
          .map((row) => {
            const cells = row
              .map((cell) => {
                const runs = renderInlineTokensToXml(cell.tokens, ctx);
                return `<w:tc><w:p>${runs}</w:p></w:tc>`;
              })
              .join("");
            return `<w:tr>${cells}</w:tr>`;
          })
          .join("");
        blocks.push(
          [
            "<w:tbl>",
            "<w:tblPr>",
            '<w:tblW w:w="5000" w:type="pct"/>',
            "<w:tblBorders>",
            '<w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>',
            '<w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>',
            '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>',
            '<w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>',
            '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>',
            '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>',
            "</w:tblBorders>",
            "</w:tblPr>",
            `<w:tr>${headerCells}</w:tr>`,
            bodyRows,
            "</w:tbl>",
          ].join(""),
        );
        break;
      }
      case "hr": {
        blocks.push(
          '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D1D5DB"/></w:pBdr></w:pPr></w:p>',
        );
        break;
      }
      default: {
        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          blocks.push(`<w:p>${buildTextRunXml(token.text.trim())}</w:p>`);
        }
        break;
      }
    }
  }

  return blocks.join("");
}

function buildStylesXml(): string {
  const headings = [
    { level: 1, size: 44, before: 320, after: 120 },
    { level: 2, size: 34, before: 280, after: 100 },
    { level: 3, size: 28, before: 220, after: 80 },
    { level: 4, size: 24, before: 180, after: 60 },
    { level: 5, size: 22, before: 140, after: 40 },
    { level: 6, size: 20, before: 120, after: 40 },
  ]
    .map(
      ({ level, size, before, after }) =>
        [
          `<w:style w:type="paragraph" w:styleId="Heading${level}">`,
          `<w:name w:val="heading ${level}"/>`,
          '<w:basedOn w:val="Normal"/>',
          '<w:next w:val="Normal"/>',
          "<w:pPr>",
          "<w:keepNext/>",
          `<w:spacing w:before="${before}" w:after="${after}"/>`,
          `<w:outlineLvl w:val="${level - 1}"/>`,
          "</w:pPr>",
          "<w:rPr>",
          "<w:b/>",
          `<w:sz w:val="${size}"/>`,
          `<w:szCs w:val="${size}"/>`,
          "</w:rPr>",
          "</w:style>",
        ].join(""),
    )
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:docDefaults>",
    "<w:rPrDefault><w:rPr>",
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>',
    '<w:sz w:val="22"/><w:szCs w:val="22"/>',
    "</w:rPr></w:rPrDefault>",
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>',
    "</w:docDefaults>",
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    headings,
    "</w:styles>",
  ].join("");
}

/**
 * Packages a Markdown document and its referenced `mdmedia://` or `pathAssets` images into a
 * self-contained `.docx` file ready for direct upload into Google Docs or Microsoft Word.
 */
export async function buildDocumentDocxPackage(
  options: BuildHermeticDocumentOptions,
): Promise<DocxDocumentPackage> {
  const { title, markdown, docPath, pathAssets, fetchMedia, now = new Date() } = options;
  const slug = deriveExportSlug({ docPath, title });

  // Discover all referenced image/asset media outside code fences
  const fenceRegex = /(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/gm;
  const nonFenceParts: string[] = [];
  let lastIndex = 0;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(markdown)) !== null) {
    if (fenceMatch.index > lastIndex) {
      nonFenceParts.push(markdown.slice(lastIndex, fenceMatch.index));
    }
    lastIndex = fenceMatch.index + fenceMatch[0].length;
  }
  if (lastIndex < markdown.length) {
    nonFenceParts.push(markdown.slice(lastIndex));
  }

  const linkRegex = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const discoveredByKey = new Map<
    string,
    { mediaRef: TreeMediaRef; contentPath: string; label: string }
  >();

  for (const part of nonFenceParts) {
    let match: RegExpExecArray | null;
    linkRegex.lastIndex = 0;
    while ((match = linkRegex.exec(part)) !== null) {
      const label = match[2] ?? "";
      const rawHref = match[3] ?? "";
      const mediaRef =
        parseMediaUri(rawHref, pathAssets, docPath) ?? parseDirectAssetContentHref(rawHref);
      if (!mediaRef || (mediaRef.type !== "image" && mediaRef.type !== "asset")) {
        continue;
      }
      const contentPath = resolvePrivateMediaContentPath(mediaRef);
      if (!contentPath) continue;
      const key = `${mediaRef.type}:${mediaRef.id}:${mediaRef.generationId ?? ""}`;
      if (!discoveredByKey.has(key)) {
        discoveredByKey.set(key, { mediaRef, contentPath, label });
      }
    }
  }

  const mediaAssets: HermeticMediaAssetEntry[] = [];
  const imageRIdByKey = new Map<
    string,
    { rId: string; cx: number; cy: number; name: string; mediaPath: string; mimeType: string }
  >();

  let imgIdx = 1;
  for (const [key, item] of discoveredByKey.entries()) {
    const payload = await fetchMedia(item.contentPath, item.mediaRef);
    const ext = extensionForMimeType(payload.mimeType, "png");
    const mediaFilename = `image${imgIdx}.${ext}`;
    const mediaRelPath = `media/${mediaFilename}`;
    const rId = `rIdImg${imgIdx}`;
    const { cx, cy } = computeImageEmuSize(payload.bytes);

    imageRIdByKey.set(key, {
      rId,
      cx,
      cy,
      name: item.label || mediaFilename,
      mediaPath: `word/${mediaRelPath}`,
      mimeType: payload.mimeType,
    });
    mediaAssets.push({
      key,
      mediaRef: item.mediaRef,
      contentPath: item.contentPath,
      archiveRelativePath: mediaRelPath,
      bytes: payload.bytes,
      mimeType: payload.mimeType,
    });
    imgIdx += 1;
  }

  let drawingCounter = 1;
  const hyperlinks: Array<{ rId: string; target: string }> = [];
  const ctx: DocxBuildContext = {
    docPath,
    pathAssets,
    imageRIdByKey,
    hyperlinks,
    nextDrawingId: () => drawingCounter++,
    registerHyperlink: (url: string) => {
      const rId = `rIdLink${hyperlinks.length + 1}`;
      hyperlinks.push({ rId, target: url });
      return rId;
    },
  };

  const tokens = lexer(markdown);
  const bodyBlocksXml = renderBlockTokensToXml(tokens, ctx);

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    "<w:body>",
    bodyBlocksXml,
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
    "</w:body>",
    "</w:document>",
  ].join("");

  const relEntries: string[] = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  ];
  for (const info of imageRIdByKey.values()) {
    const relTarget = info.mediaPath.replace(/^word\//, "");
    relEntries.push(
      `<Relationship Id="${info.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeXml(relTarget)}"/>`,
    );
  }
  for (const link of hyperlinks) {
    relEntries.push(
      `<Relationship Id="${link.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(link.target)}" TargetMode="External"/>`,
    );
  }

  const documentRelsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relEntries.join(""),
    "</Relationships>",
  ].join("");

  const rootRelsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    "</Relationships>",
  ].join("");

  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="webp" ContentType="image/webp"/>',
    '<Default Extension="gif" ContentType="image/gif"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    "</Types>",
  ].join("");

  const zipEntries: ZipEntryInput[] = [
    { path: "[Content_Types].xml", data: contentTypesXml, mtime: now },
    { path: "_rels/.rels", data: rootRelsXml, mtime: now },
    { path: "word/document.xml", data: documentXml, mtime: now },
    { path: "word/styles.xml", data: buildStylesXml(), mtime: now },
    { path: "word/_rels/document.xml.rels", data: documentRelsXml, mtime: now },
    ...mediaAssets.map((asset) => ({
      path: `word/${asset.archiveRelativePath}`,
      data: asset.bytes,
      mtime: now,
    })),
  ];

  const docxBytes = createZipArchive(zipEntries);
  return {
    docxBytes,
    docxFilename: `${slug}.docx`,
    slug,
    mediaAssets,
  };
}
