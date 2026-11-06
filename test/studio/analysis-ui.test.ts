import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { MEDIA_TYPES } from '../../studio/src/lib/media-types';

const root = join(import.meta.dir, '..', '..', 'studio', 'src');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const NEW_FILES = ['components/media/analysis-editor.tsx', 'components/media/analysis-answer.tsx', 'app/(app)/studio/analysis/page.tsx', 'app/(app)/analysis/[id]/page.tsx', 'lib/analysis-draft.ts'];

describe('analysis UI wiring', () => {
  it('registers Analysis as an available medium with its composer route', () => {
    expect(MEDIA_TYPES.find(item => item.type === 'analysis')).toEqual({ type: 'analysis', label: 'Analysis', composer: '/studio/analysis', available: true });
    expect(read('app/(app)/studio/analysis/page.tsx')).toContain('<AnalysisEditor />');
    expect(read('app/(app)/analysis/[id]/page.tsx')).toContain('<AnalysisEditor key={id} id={id} />');
  });

  it('gives analysis its icon wherever media types are drawn, and polls its activity', () => {
    expect(read('components/shell/create-menu.tsx')).toContain("item.type === 'analysis' ? <ScanSearch");
    expect(read('components/media/media-directory.tsx')).toContain("row.type === 'analysis' ? <ScanSearch");
    expect(read('components/media/media-activity-provider.tsx')).toContain("'sfx', 'analysis'");
    expect(read('components/shell/nav-rail.tsx')).toContain('pathname.startsWith("/analysis/")');
  });

  it('opens the composer from a video and from each clip', () => {
    const editor = read('components/media/video-editor.tsx');
    expect(editor).toContain('onSelect={() => analyze()}><ScanSearch size={16} />Analyze</DropdownMenuItem>');
    expect(editor).toContain('label={`Analyze clip ${clip.index}`}');
    expect(editor).toContain("router.push(`/studio/analysis?draft=${draft}`)");
  });
});

describe('analysis UI stays calm', () => {
  const editor = read('components/media/analysis-editor.tsx');
  it('offers exactly three sources, one action, and keeps settings in the options drawer', () => {
    for (const label of ['Upload video</Button>', 'From Library</Button>', 'YouTube link</Button>', "'Analyze'", '/>Long video mode</label>', '/>Narrate result</label>']) expect(editor).toContain(label);
    expect(editor).toContain("label: 'Analysis options'");
    expect(editor.indexOf('Long video mode')).toBeGreaterThan(editor.indexOf("drawer === 'library' ?"));
  });

  it('shows progress as one muted, truncated line under Analyzing…, and nothing else', () => {
    const running = editor.slice(editor.indexOf('{busy && !selected'), editor.indexOf('{(failed?.error || error)'));
    expect(running).toContain('Analyzing…');
    expect(running).toContain('{latest?.progress && <p className="col-start-2 truncate text-xs">{latest.progress}</p>}');
    expect(running.match(/<p\b/g)).toHaveLength(2);
    expect(editor).not.toContain('progress.map');
  });

  it('renders the analysis as a reader-aligned document with no inline follow-up UI, and renders JSON as code', () => {
    const answer = read('components/media/analysis-answer.tsx');
    expect(answer).toContain('<CodeBlock code={code} lang="json" />');
    expect(answer).toContain('normalizeAnalysisMarkdown(markdown)');
    expect(editor).toContain('viewGrid gridVariant="reader"');
    expect(editor).toContain("const json = result?.assets[0]?.mimeType === 'application/json';");
    expect(editor).toContain('{!narration && !json && <DropdownMenuItem');
    expect(editor).toContain('<AnalysisAnswer markdown={answer} json={json} onSeek={seek} />');
    for (const removed of ['Ask a follow-up', 'analysisFollowUp', '>Ask</Button>']) expect(editor).not.toContain(removed);
    for (const word of ['responseSchema', 'Schema', 'schema']) expect(editor).not.toContain(word);
  });

  it('shows no provider jargon, receipts, token counts or phase names', () => {
    for (const word of ['Agentic', '>agentic', 'Interaction id', 'interaction id', 'usage', 'Token', 'Uploading…', 'Preparing…', 'phase']) expect(editor).not.toContain(word);
  });

  it('follows the Studio design standards', () => {
    const margin = /\b(?:-?m[xytrblse]?-(?:\d+|px|auto|\[[^\]]+\])|space-[xy]-(?:\d+|px|reverse|\[[^\]]+\]))\b/;
    const oneSided = /\bp[trblse]-(?:\d+|px|\[[^\]]+\])\b/;
    const violations = NEW_FILES.flatMap(file => { expect(existsSync(join(root, file))).toBe(true); return read(file).split('\n').flatMap((line, index) => [
      margin.test(line) ? `${file}:${index + 1} margin` : '', oneSided.test(line) ? `${file}:${index + 1} one-sided padding` : '',
      /animate-(ping|pulse)/.test(line) ? `${file}:${index + 1} pulse` : '', line.includes('dangerouslySetInnerHTML') ? `${file}:${index + 1} raw HTML` : '',
    ].filter(Boolean)); });
    expect(violations).toEqual([]);
  });
});
