"use client";

import {
  buildDocumentDocxPackage,
  type DocxDocumentPackage,
} from "./docx-export";
import {
  buildHermeticDocumentPackage,
  deriveExportSlug,
  type HermeticDocumentPackage,
} from "./hermetic-export";
import { studioFetch } from "./media-client";
import type { TreeMediaRef } from "./tree-types";

export { deriveExportSlug };

export interface DownloadHermeticDocumentInput {
  title: string;
  markdown: string;
  docPath?: string;
  pathAssets?: Record<string, TreeMediaRef>;
}

async function fetchStudioMediaPayload(contentPath: string) {
  const url = new URL(contentPath, window.location.origin);
  const response = await studioFetch(`${url.pathname}${url.search}`);
  const mimeType =
    response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(arrayBuffer),
    mimeType,
  };
}

export async function downloadHermeticDocumentZip(
  input: DownloadHermeticDocumentInput,
): Promise<HermeticDocumentPackage> {
  const pkg = await buildHermeticDocumentPackage({
    ...input,
    fetchMedia: (contentPath) => fetchStudioMediaPayload(contentPath),
  });

  const blob = new Blob([pkg.zipBytes.buffer as ArrayBuffer], {
    type: "application/zip",
  });
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = pkg.zipFilename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);

  return pkg;
}

export async function downloadDocumentDocx(
  input: DownloadHermeticDocumentInput,
): Promise<DocxDocumentPackage> {
  const pkg = await buildDocumentDocxPackage({
    ...input,
    fetchMedia: (contentPath) => fetchStudioMediaPayload(contentPath),
  });

  const blob = new Blob([pkg.docxBytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = pkg.docxFilename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);

  return pkg;
}
