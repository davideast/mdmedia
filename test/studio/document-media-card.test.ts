import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import React, { createElement, type ReactElement } from 'react';
import {
  DocumentMediaCard,
  resolvePrivateMediaContentPath,
} from '../../studio/src/components/reader/document-media-card';

const studioReactDomServer = resolve(
  import.meta.dir,
  '../../studio/node_modules/react-dom/server.js',
);
if (!existsSync(studioReactDomServer)) {
  const req = createRequire(import.meta.url);
  const reactDomPkg = req('react-dom/package.json') as { version?: string };
  if (reactDomPkg.version && React.version !== reactDomPkg.version) {
    Object.defineProperty(React, 'version', {
      value: reactDomPkg.version,
      configurable: true,
      writable: true,
    });
  }
}
const { renderToStaticMarkup } = (await import(
  existsSync(studioReactDomServer)
    ? '../../studio/node_modules/react-dom/server'
    : 'react-dom/server'
)) as {
  renderToStaticMarkup: (element: ReactElement) => string;
};
import { TooltipProvider } from '../../studio/src/components/ui/tooltip';
import {
  buildDocumentDocxPackage,
  readImageDimensions,
} from '../../studio/src/lib/docx-export';
import {
  buildHermeticDocumentPackage,
  crc32,
  createZipArchive,
  deriveExportSlug,
} from '../../studio/src/lib/hermetic-export';
import {
  buildMediaRemixApiPayload,
  executeMediaRemix,
  REMIX_ACTIONS_BY_SOURCE,
} from '../../studio/src/lib/media-remix';
import {
  InMemoryTreeStore,
  resolveTreeNode,
} from '../../studio/src/lib/tree-fakes';
import type {
  MediaRemixKind,
  MediaRemixRequest,
  TreeMediaRef,
  TreeOp,
} from '../../studio/src/lib/tree-types';

describe('REMIX_ACTIONS_BY_SOURCE & buildMediaRemixApiPayload', () => {
  it('exposes the required cross-modal remix actions for image, video, mermaid, music, sfx, and asset sources', () => {
    expect(REMIX_ACTIONS_BY_SOURCE.image.map((a) => a.kind)).toEqual([
      'image_to_image',
      'image_to_video_first_frame',
      'image_to_video_reference',
      'image_to_music',
    ]);
    expect(REMIX_ACTIONS_BY_SOURCE.video.map((a) => a.kind)).toEqual([
      'video_extend',
      'video_edit',
      'video_to_image',
    ]);
    expect(REMIX_ACTIONS_BY_SOURCE.mermaid.map((a) => a.kind)).toEqual([
      'mermaid_to_image',
    ]);
    expect(REMIX_ACTIONS_BY_SOURCE.text.map((a) => a.kind)).toEqual([
      'text_to_image',
      'text_to_video',
      'text_to_music',
    ]);
    expect(REMIX_ACTIONS_BY_SOURCE.music.length).toBeGreaterThan(0);
    expect(REMIX_ACTIONS_BY_SOURCE.sfx.length).toBeGreaterThan(0);
    expect(REMIX_ACTIONS_BY_SOURCE.asset.length).toBeGreaterThan(0);
  });

  it('builds Studio API payloads for all cross-modal remix kinds', () => {
    const imgPay = buildMediaRemixApiPayload({
      kind: 'image_to_image',
      source: { type: 'image', id: 'img_10', generationId: 'gen_1' },
      prompt: 'Add dramatic dusk lighting',
      placement: 'replace',
    });
    expect(imgPay.endpoint).toBe('/api/v1/images/img_10/generations');
    expect(imgPay.targetType).toBe('image');
    expect(imgPay.body.action).toBe('refine');

    const vidFirstFrame = buildMediaRemixApiPayload({
      kind: 'image_to_video_first_frame',
      source: { type: 'image', id: 'img_10' },
      prompt: 'Camera pans across the horizon',
      placement: 'insert_below',
    });
    expect(vidFirstFrame.endpoint).toBe('/api/v1/videos');
    expect(vidFirstFrame.targetType).toBe('video');
    expect(vidFirstFrame.body.referenceRole).toBe('first_frame');

    const vidRef = buildMediaRemixApiPayload({
      kind: 'image_to_video_reference',
      source: { type: 'image', id: 'img_10' },
      prompt: 'Keep character style in motion',
      placement: 'insert_below',
    });
    expect(vidRef.endpoint).toBe('/api/v1/videos');
    expect(vidRef.body.referenceRole).toBe('reference');

    const imgMusic = buildMediaRemixApiPayload({
      kind: 'image_to_music',
      source: { type: 'image', id: 'img_10' },
      prompt: 'Ambient synth underscore',
      placement: 'insert_below',
    });
    expect(imgMusic.endpoint).toBe('/api/v1/music');
    expect(imgMusic.targetType).toBe('music');
    expect(imgMusic.body.referenceAssetId).toBe('img_10');

    const vidExtend = buildMediaRemixApiPayload({
      kind: 'video_extend',
      source: { type: 'video', id: 'vid_20', generationId: 'gen_v1' },
      prompt: 'Continue the drone flyover',
      placement: 'replace',
    });
    expect(vidExtend.endpoint).toBe('/api/v1/videos/vid_20/generations');
    expect(vidExtend.targetType).toBe('video');
    expect(vidExtend.body.action).toBe('continue');
    expect(vidExtend.body.fromGenerationId).toBe('gen_v1');

    const mermaidImg = buildMediaRemixApiPayload({
      kind: 'mermaid_to_image',
      source: { type: 'mermaid', code: 'flowchart LR\nA --> B' },
      prompt: 'Isometric editorial illustration',
      placement: 'insert_below',
    });
    expect(mermaidImg.endpoint).toBe('/api/v1/images');
    expect(mermaidImg.targetType).toBe('image');
    expect(mermaidImg.body.adaptation).toEqual({
      enabled: true,
      instructions: 'Isometric editorial illustration',
    });
    expect(String(mermaidImg.body.prompt)).toContain('flowchart LR');

    const textImg = buildMediaRemixApiPayload({
      kind: 'text_to_image',
      source: { type: 'text', text: 'PREPARED MATRIX -> INK + WIPE -> PRESS -> LIFT' },
      prompt: 'Step-by-step intaglio workshop diagram',
      placement: 'insert_below',
    });
    expect(textImg.endpoint).toBe('/api/v1/images');
    expect(textImg.targetType).toBe('image');
    expect(String(textImg.body.prompt)).toContain('PREPARED MATRIX');

    const textVid = buildMediaRemixApiPayload({
      kind: 'text_to_video',
      source: { type: 'text', text: 'Paper receives ink from etched recesses under pressure.' },
      prompt: 'Macro slow-motion shot of printing press roller',
      placement: 'insert_below',
    });
    expect(textVid.endpoint).toBe('/api/v1/videos');
    expect(textVid.targetType).toBe('video');
    expect(String(textVid.body.prompt)).toContain('Paper receives ink');

    const textMus = buildMediaRemixApiPayload({
      kind: 'text_to_music',
      source: { type: 'text', text: 'Goya — The Sleep of Reason Produces Monsters' },
      prompt: 'Dark classical chamber strings',
      placement: 'insert_below',
    });
    expect(textMus.endpoint).toBe('/api/v1/music');
    expect(textMus.targetType).toBe('music');
    expect(String(textMus.body.prompt)).toContain('The Sleep of Reason');
  });
});

describe('executeMediaRemix across all cross-modal workflows & placements', () => {
  const workflows: Array<{
    kind: MediaRemixKind;
    source: MediaRemixRequest['source'];
    createdRef: TreeMediaRef;
    initialMarkdown: string;
    expectedRefToken: string;
  }> = [
    {
      kind: 'image_to_image',
      source: { type: 'image', id: 'img_src' },
      createdRef: { type: 'image', id: 'img_refined', generationId: 'gen_r1' },
      initialMarkdown: '# Scene\n\n![Hero](mdmedia://image/img_src)\n',
      expectedRefToken: 'mdmedia://image/img_refined@gen_r1',
    },
    {
      kind: 'image_to_video_first_frame',
      source: { type: 'image', id: 'img_src' },
      createdRef: { type: 'video', id: 'vid_ff' },
      initialMarkdown: '# Scene\n\n![Hero](mdmedia://image/img_src)\n',
      expectedRefToken: 'mdmedia://video/vid_ff',
    },
    {
      kind: 'image_to_video_reference',
      source: { type: 'image', id: 'img_src' },
      createdRef: { type: 'video', id: 'vid_ref' },
      initialMarkdown: '# Scene\n\n![Hero](mdmedia://image/img_src)\n',
      expectedRefToken: 'mdmedia://video/vid_ref',
    },
    {
      kind: 'image_to_music',
      source: { type: 'image', id: 'img_src' },
      createdRef: { type: 'music', id: 'mus_score' },
      initialMarkdown: '# Scene\n\n![Hero](mdmedia://image/img_src)\n',
      expectedRefToken: '[Media](mdmedia://music/mus_score)',
    },
    {
      kind: 'video_extend',
      source: { type: 'video', id: 'vid_src' },
      createdRef: { type: 'video', id: 'vid_src', generationId: 'gen_ext2' },
      initialMarkdown: '# Clip\n\n![Shot](mdmedia://video/vid_src)\n',
      expectedRefToken: 'mdmedia://video/vid_src@gen_ext2',
    },
    {
      kind: 'mermaid_to_image',
      source: { type: 'mermaid', code: 'graph TD;\nA-->B;' },
      createdRef: { type: 'image', id: 'img_from_mermaid' },
      initialMarkdown: '# Arch\n\n```mermaid\ngraph TD;\nA-->B;\n```\n',
      expectedRefToken: 'mdmedia://image/img_from_mermaid',
    },
    {
      kind: 'text_to_image',
      source: { type: 'text', text: 'In the simplified printing model below, paper receives ink from recesses.' },
      createdRef: { type: 'image', id: 'img_from_text' },
      initialMarkdown:
        '# Intaglio\n\nIn the simplified printing model below, paper receives ink from recesses.\n\nNext paragraph.\n',
      expectedRefToken: 'mdmedia://image/img_from_text',
    },
    {
      kind: 'text_to_video',
      source: { type: 'text', text: 'PREPARED MATRIX -> INK + WIPE -> PRESS -> LIFT' },
      createdRef: { type: 'video', id: 'vid_from_text' },
      initialMarkdown:
        '# Process\n\n```text\nPREPARED MATRIX -> INK + WIPE -> PRESS -> LIFT\n```\n',
      expectedRefToken: 'mdmedia://video/vid_from_text',
    },
  ];

  for (const wf of workflows) {
    it(`executes ${wf.kind} with insert_below, replace, and library_only`, async () => {
      const store = new InMemoryTreeStore('user_remix');
      const tree = await store.createTree('user_remix', {
        title: `Remix ${wf.kind}`,
        ops: [{ op: 'put_doc', path: 'doc.md', markdown: wf.initialMarkdown }],
      });
      const node = resolveTreeNode(tree, 'doc.md')!.node;

      const recordedOps: Array<Extract<TreeOp, { op: 'replace_media_ref' }>> = [];

      // 1. insert_below preserves original block and appends new media ref below
      const insertRes = await executeMediaRemix(
        {
          kind: wf.kind,
          source: wf.source,
          prompt: `Insert below for ${wf.kind}`,
          placement: 'insert_below',
        },
        {
          nodeId: node.id,
          markdown: wf.initialMarkdown,
          generateMedia: async () => wf.createdRef,
          applyReplaceOp: async (op) => {
            recordedOps.push(op);
            await store.applyOps('user_remix', tree.id, [op]);
          },
        },
      );

      expect(insertRes.createdRef).toEqual(wf.createdRef);
      expect(insertRes.updatedMarkdown).toContain(wf.expectedRefToken);
      expect(recordedOps).toHaveLength(1);
      expect(recordedOps[0]?.placement).toBe('insert_below');

      const docAfterInsert = await store.getDocument('user_remix', tree.id, node.id);
      expect(docAfterInsert.markdown).toContain(wf.expectedRefToken);

      // Reset doc for replace test
      await store.applyOps('user_remix', tree.id, [
        { op: 'put_doc', path: 'doc.md', markdown: wf.initialMarkdown },
      ]);

      // 2. replace swaps original media reference in-place
      const replaceRes = await executeMediaRemix(
        {
          kind: wf.kind,
          source: wf.source,
          prompt: `Replace for ${wf.kind}`,
          placement: 'replace',
        },
        {
          nodeId: node.id,
          markdown: wf.initialMarkdown,
          generateMedia: async () => wf.createdRef,
          applyReplaceOp: async (op) => {
            recordedOps.push(op);
            await store.applyOps('user_remix', tree.id, [op]);
          },
        },
      );

      expect(replaceRes.createdRef).toEqual(wf.createdRef);
      expect(replaceRes.updatedMarkdown).toContain(wf.expectedRefToken);
      expect(recordedOps).toHaveLength(2);
      expect(recordedOps[1]?.placement).toBe('replace');

      const docAfterReplace = await store.getDocument('user_remix', tree.id, node.id);
      expect(docAfterReplace.markdown).toContain(wf.expectedRefToken);

      // 3. library_only generates media without mutating the document
      const libOnlyRes = await executeMediaRemix(
        {
          kind: wf.kind,
          source: wf.source,
          prompt: `Library only for ${wf.kind}`,
          placement: 'library_only',
        },
        {
          nodeId: node.id,
          markdown: wf.initialMarkdown,
          generateMedia: async () => wf.createdRef,
          applyReplaceOp: async (op) => {
            recordedOps.push(op);
          },
        },
      );

      expect(libOnlyRes.createdRef).toEqual(wf.createdRef);
      expect(libOnlyRes.updatedMarkdown).toBeUndefined();
      // applyReplaceOp must NOT have been called for library_only
      expect(recordedOps).toHaveLength(2);
    });
  }
});

describe('<DocumentMediaCard /> rendering & unified header toolbar', () => {
  it('resolves private media paths and renders a single card with top toolbar Remix action and bottom drawer', () => {
    expect(resolvePrivateMediaContentPath({ type: 'image', id: 'img_1' })).toBe(
      '/api/v1/assets/img_1/content',
    );
    expect(
      resolvePrivateMediaContentPath({
        type: 'video',
        id: 'vid_1',
        generationId: 'gen_77',
      }),
    ).toBe('/api/v1/assets/gen_77/content');
    expect(resolvePrivateMediaContentPath({ type: 'mermaid', id: 'graph TD;A-->B;' })).toBeNull();

    const html = renderToStaticMarkup(
      createElement(DocumentMediaCard, {
        mediaRef: { type: 'image', id: 'img_hero_42' },
        alt: 'Architecture Diagram',
        initialObjectUrl: 'blob:http://localhost:3080/hero',
        defaultComposerOpen: true,
      }),
    );

    expect(html).toContain('Architecture Diagram');
    expect(html).toContain('data-image-collapsible="true"');
    expect(html).toContain('data-image-expanded="false"');
    expect(html).toContain('max-h-[24rem]');
    expect(html).toContain('Click to expand full image');
    expect(html).toContain('Open Architecture Diagram in full screen');
    expect(html).toContain('Remix');
    expect(html).toContain('Refine Image');
    expect(html).toContain('Animate as Video (First Frame)');
    expect(html).toContain('Video with Reference');
    expect(html).toContain('Score Music from Mood');
    expect(html).toContain('Insert below');
    expect(html).toContain('Replace in document');
    expect(html).toContain('Save to library only');

    const mermaidHtml = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(DocumentMediaCard, {
          mediaRef: { type: 'mermaid', id: 'flowchart LR\nA --> B' },
          alt: 'Mermaid diagram',
        }),
      ),
    );

    expect(mermaidHtml).toContain('data-media-type="mermaid"');
    expect(mermaidHtml).toContain('Flowchart');
    expect(mermaidHtml).toContain('Remix');
  });
});

describe('buildHermeticDocumentPackage & createZipArchive', () => {
  it('rewrites mdmedia:// and pathAssets links to local ./images/ paths and packs a valid PKZIP archive', async () => {
    const markdown = [
      '# What the quota benchmark showed, in plain terms',
      '',
      '![Media](mdmedia://image/img_quota_1)',
      '',
      'Look at Goya:',
      '',
      '![Goya — The Sleep of Reason](../../../works/goya-sleep-of-reason/art/met-338473.jpg)',
      '',
      '```markdown',
      '![Untouched example](mdmedia://image/img_quota_1)',
      '```',
      '',
    ].join('\n');

    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fakeJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const pkg = await buildHermeticDocumentPackage({
      title: 'What the quota benchmark showed, in plain terms',
      docPath: 'techniques/intaglio/index.md',
      markdown,
      pathAssets: {
        'works/goya-sleep-of-reason/art/met-338473.jpg': {
          type: 'asset',
          id: 'ast_goya_99',
        },
      },
      fetchMedia: async (contentPath) => {
        if (contentPath.includes('img_quota_1')) {
          return { bytes: fakePng, mimeType: 'image/png' };
        }
        return { bytes: fakeJpg, mimeType: 'image/jpeg' };
      },
    });

    expect(
      deriveExportSlug({
        docPath: 'quota-benchmark-narrative-10-26-26.md',
        title: 'What the quota benchmark showed, in plain terms',
      }),
    ).toBe('quota-benchmark-narrative-10-26-26');
    expect(pkg.zipFilename).toBe('intaglio.zip');
    expect(pkg.mediaAssets).toHaveLength(2);
    expect(pkg.mediaAssets[0]?.archiveRelativePath).toBe('images/01-image-imgquota.png');
    expect(pkg.mediaAssets[1]?.archiveRelativePath).toBe('images/met-338473.jpg');

    expect(pkg.rewrittenMarkdown).toContain('![Media](./images/01-image-imgquota.png)');
    expect(pkg.rewrittenMarkdown).toContain(
      '![Goya — The Sleep of Reason](./images/met-338473.jpg)',
    );
    // Code fence example remains untouched
    expect(pkg.rewrittenMarkdown).toContain('![Untouched example](mdmedia://image/img_quota_1)');

    // Verify PKZIP signatures (Local File Header 0x04034b50 & End of Central Directory 0x06054b50)
    const view = new DataView(pkg.zipBytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(pkg.zipBytes.length - 22, true)).toBe(0x06054b50);
    // 3 entries total in End of Central Directory (1 markdown + 2 images)
    expect(view.getUint16(pkg.zipBytes.length - 12, true)).toBe(3);
    expect(crc32(fakePng)).toBeGreaterThan(0);
    expect(createZipArchive([{ path: 'hello.txt', data: 'hello' }]).length).toBeGreaterThan(50);
  });

  it('builds a valid OpenXML .docx archive with embedded word/media/* images and Heading styles', async () => {
    // 24-byte PNG header with IHDR width=1200, height=630
    const pngWithDims = new Uint8Array(24);
    pngWithDims.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dimView = new DataView(pngWithDims.buffer);
    dimView.setUint32(16, 1200, false);
    dimView.setUint32(20, 630, false);

    expect(readImageDimensions(pngWithDims)).toEqual({ width: 1200, height: 630 });

    const docxPkg = await buildDocumentDocxPackage({
      title: 'What the quota benchmark showed, in plain terms',
      docPath: 'quota-benchmark-narrative-10-26-26.md',
      markdown: [
        '# What the quota benchmark showed, in plain terms',
        '',
        '![Handling High-Contention Database Events](mdmedia://image/img_quota_1)',
        '',
        'The live run on **26 Oct 2026** passed.',
        '',
        '| Metric | p95 |',
        '| --- | --- |',
        '| Latency | 0.4s |',
      ].join('\n'),
      fetchMedia: async () => ({
        bytes: pngWithDims,
        mimeType: 'image/png',
      }),
    });

    expect(docxPkg.docxFilename).toBe('quota-benchmark-narrative-10-26-26.docx');
    expect(docxPkg.mediaAssets).toHaveLength(1);
    expect(docxPkg.mediaAssets[0]?.archiveRelativePath).toBe('media/image1.png');

    const zipView = new DataView(docxPkg.docxBytes.buffer);
    expect(zipView.getUint32(0, true)).toBe(0x04034b50);
    expect(zipView.getUint32(docxPkg.docxBytes.length - 22, true)).toBe(0x06054b50);
    // 6 entries: [Content_Types].xml, _rels/.rels, word/document.xml, word/styles.xml, word/_rels/document.xml.rels, word/media/image1.png
    expect(zipView.getUint16(docxPkg.docxBytes.length - 12, true)).toBe(6);

    const rawText = new TextDecoder().decode(docxPkg.docxBytes);
    expect(rawText).toContain('w:styleId="Heading1"');
    expect(rawText).toContain('r:embed="rIdImg1"');
    expect(rawText).toContain('Target="media/image1.png"');
  });
});

