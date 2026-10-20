'use client';

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, ChevronLeft } from 'lucide-react';
import { cn } from 'cn';
import type { ResolvedSegment } from 'mdmedia/cut';
import { useCutComments } from '@/components/cut/comments-panel';
import { CutProblems, CutViewer } from '@/components/cut/cut-viewer';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useMediaLinks, useSteadySource } from '@/lib/use-media-links';
import { useStudioResource } from '@/lib/use-studio-resource';
import {
  clockLength,
  cutPageTitle,
  labelDetail,
  newestFirst,
  shortLabel,
  STATUS_LABELS,
  type ProductionCutResource,
  type ProductionCutSummary,
  type ProductionSummary,
} from '@/lib/productions';
import { StatusDot, StatusPill } from './production-parts';

const cutHref = (productionId: string, cutId: string) => `/productions/${encodeURIComponent(productionId)}/cuts/${encodeURIComponent(cutId)}`;

/**
 * The playhead carried from one version to the next. Switching between two
 * cut-kind versions keeps the time; it's handed over in memory, never in
 * the URL, so links and restored tabs open at the start.
 */
let handoff: { productionId: string; cutId: string; time: number } | null = null;
function takeHandoff(productionId: string, cutId: string): number | undefined {
  const value = handoff && handoff.productionId === productionId && handoff.cutId === cutId ? handoff.time : undefined;
  handoff = null;
  return value;
}

/**
 * `/productions/{id}/cuts/{cutId}`: one version of a production. A cut with a
 * cut file opens in the cut viewer, its video and shot thumbnails on signed
 * links; a rendered-only take opens as the player and its note. The header
 * leads back to the production and switches between its versions.
 */
export function ProductionCutPage({ productionId, cutId }: { productionId: string; cutId: string }) {
  const productionPath = `/api/v1/productions/${encodeURIComponent(productionId)}`;
  const { data: production } = useStudioResource<ProductionSummary>(productionPath);
  const { data: cut, error } = useStudioResource<ProductionCutResource>(`${productionPath}/cuts/${encodeURIComponent(cutId)}`);
  const [startAt] = useState(() => takeHandoff(productionId, cutId));
  const playheadRef = useRef<() => number>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const router = useRouter();

  const summary = production?.cuts.find((item) => item.id === cutId) ?? null;
  const ids = useMemo(() => (cut ? [cut.renderedAssetId, ...Object.values(cut.thumbs)] : []), [cut]);
  const { links, refresh } = useMediaLinks(ids);
  const src = cut?.renderedAssetId ? links[cut.renderedAssetId]?.content : undefined;
  const { recover } = useSteadySource(videoRef, src, refresh);
  const thumbnail = useCallback((segment: ResolvedSegment) => {
    const asset = cut?.thumbs[segment.id];
    return asset ? links[asset]?.content ?? null : null;
  }, [cut, links]);

  const label = summary?.label ?? cut?.label ?? cutId;
  const cutLabel = useCallback((id: string) => shortLabel(production?.cuts.find((item) => item.id === id)?.label ?? id), [production]);
  const linkToCut = useCallback((id: string) => cutHref(productionId, id), [productionId]);
  const comments = useCutComments({ productionId, cutId, cutLabel, cutHref: linkToCut });
  const title = production ? cutPageTitle({ label }, production) : shortLabel(label);

  const switchTo = useCallback((next: ProductionCutSummary) => {
    if (next.id === cutId) return;
    const time = playheadRef.current?.();
    // Only cut files share a timeline worth keeping the time on.
    if (cut?.kind === 'cut' && next.kind === 'cut' && time !== undefined) handoff = { productionId, cutId: next.id, time };
    router.push(cutHref(productionId, next.id));
  }, [cut?.kind, cutId, productionId, router]);

  const titleNode = (
    <VersionTitle production={production} productionId={productionId} cutId={cutId} label={label} onSwitch={switchTo} />
  );

  if (!cut) {
    return (
      <WorkbenchPanel workspacePage className="dark" title={title} titleNode={titleNode} bodyClassName="p-6">
        <p role={error ? 'alert' : 'status'} className={cn('text-sm', error ? 'text-destructive' : 'text-ink-muted')}>{error || 'Loading version…'}</p>
      </WorkbenchPanel>
    );
  }
  if (cut.kind === 'cut' && !cut.timeline) {
    return <CutProblems title={title} titleNode={titleNode} message="This cut no longer resolves." errors={cut.errors} />;
  }
  if (cut.kind === 'cut' && cut.timeline) {
    return (
      <CutViewer
        workspacePage
        timeline={cut.timeline}
        title={title}
        titleNode={titleNode}
        video={src}
        videoRef={videoRef}
        onVideoError={recover}
        thumbnail={thumbnail}
        notes={cut.notes || undefined}
        source={cut.source?.cut?.split('/').pop()}
        startAt={startAt}
        readPlayhead={playheadRef}
        comments={comments}
      />
    );
  }
  return <RenderedCut cut={cut} title={title} titleNode={titleNode} src={src} videoRef={videoRef} onError={recover} />;
}

/**
 * The header: back to the production, then this version as a compact menu of
 * every version with its status, newest first.
 */
function VersionTitle({ production, productionId, cutId, label, onSwitch }: {
  production: ProductionSummary | null;
  productionId: string;
  cutId: string;
  label: string;
  onSwitch: (cut: ProductionCutSummary) => void;
}) {
  const cuts = production ? newestFirst(production.cuts) : [];
  const current = cuts.find((item) => item.id === cutId);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Link
        href={`/productions/${encodeURIComponent(productionId)}`}
        title={production ? `Back to ${production.title}` : 'Back to the production'}
        className="-ml-1 inline-flex h-7 min-w-0 items-center gap-0.5 rounded-md pr-1.5 pl-0.5 text-ink-muted transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <ChevronLeft size={15} strokeWidth={2} className="flex-none" />
        <span className="truncate">{production?.title ?? 'Production'}</span>
      </Link>
      <span aria-hidden className="flex-none text-ink-faint">/</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          disabled={!production}
          aria-label={`Version: ${label}. Switch version`}
          className="group inline-flex h-7 max-w-[55%] flex-none items-center gap-1.5 rounded-md px-1.5 text-foreground transition-colors hover:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden data-[state=open]:bg-foreground/[0.07]"
        >
          {current ? <StatusDot status={current.status} /> : null}
          <span className="truncate">{shortLabel(label)}</span>
          <ChevronDown size={13} strokeWidth={2} className="flex-none text-ink-muted transition-transform group-data-[state=open]:rotate-180" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="dark max-h-[min(28rem,70dvh)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-1">
          {cuts.map((item) => (
            <DropdownMenuItem key={item.id} onSelect={() => onSwitch(item)} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 py-2">
              <StatusDot status={item.status} className="row-span-2 self-start mt-[5px]" />
              <span className="truncate text-[13px] font-medium">
                {shortLabel(item.label)}
                {labelDetail(item.label) ? <span className="font-normal text-ink-muted"> · {labelDetail(item.label)}</span> : null}
              </span>
              <span className="row-span-2 self-start pt-0.5">{item.id === cutId ? <Check size={14} className="text-foreground" /> : null}</span>
              <span className="text-[12px] text-ink-muted tabular-nums">
                {[STATUS_LABELS[item.status], clockLength(item.lengthSeconds), item.kind === 'rendered' ? 'Video only' : null, item.id === production?.approvedCutId ? 'Approved cut' : null].filter(Boolean).join(' · ')}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

type Frame = 'tv' | 'full';

/** A rendered-only take: the player, framed like the cut viewer's, and its note. */
function RenderedCut({ cut, title, titleNode, src, videoRef, onError }: {
  cut: ProductionCutResource;
  title: string;
  titleNode: React.ReactNode;
  src: string | undefined;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onError: () => void;
}) {
  const [frame, setFrame] = useState<Frame>('tv');
  const [failed, setFailed] = useState(false);
  const aspect = frame === 'tv' ? 4 / 3 : 16 / 9;
  const detail = labelDetail(cut.label);
  return (
    <WorkbenchPanel workspacePage className="dark" title={title} titleNode={titleNode} bodyClassName="p-0">
      <div className="flex min-h-full flex-1 flex-col gap-4 px-4 pt-4 pb-5 lg:flex-row lg:px-6">
        <div className="relative aspect-[4/3] max-h-[70dvh] w-full overflow-hidden rounded-[10px] bg-black ring-1 ring-white/[0.08] [container-type:size] lg:max-h-[calc(100dvh-7rem)] lg:min-w-0 lg:flex-1">
          <div
            className="absolute top-1/2 left-1/2 w-[min(100cqw,calc(100cqh*var(--aspect)))] -translate-x-1/2 -translate-y-1/2 overflow-hidden transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ '--aspect': aspect, aspectRatio: String(aspect) } as CSSProperties}
          >
            <video
              ref={videoRef}
              controls
              playsInline
              preload="auto"
              onCanPlay={() => setFailed(false)}
              onError={() => { setFailed(true); onError(); }}
              aria-label={cut.label}
              className={cn('absolute inset-0 h-full w-full', frame === 'tv' ? 'object-cover' : 'object-contain')}
            />
            {failed || !src ? (
              <p role={failed ? 'alert' : 'status'} className="pointer-events-none absolute inset-0 grid place-content-center p-6 text-center text-sm text-ink-muted">
                {failed ? 'The video isn’t available.' : 'Loading video…'}
              </p>
            ) : null}
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-5 rounded-[10px] border border-border bg-surface-inset p-4 lg:max-h-[calc(100dvh-7rem)] lg:w-[23rem] lg:flex-none lg:self-start lg:overflow-y-auto">
          <div className="flex items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <h1 className="text-[17px] leading-[24px] font-semibold text-foreground">{shortLabel(cut.label)}</h1>
              {detail ? <p className="text-[13px] text-foreground/80">{detail}</p> : null}
            </div>
            <StatusPill status={cut.status} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-ink-muted tabular-nums">
              {[clockLength(cut.lengthSeconds), new Date(cut.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), 'Video only'].filter(Boolean).join(' · ')}
            </p>
            <div role="group" aria-label="Frame" className="flex h-8 flex-none items-center rounded-full bg-foreground/[0.07] p-0.5 text-[12px] font-medium">
              {(['tv', 'full'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={frame === value}
                  onClick={() => setFrame(value)}
                  className={cn('h-7 rounded-full px-3 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden', frame === value ? 'bg-foreground/[0.14] text-foreground' : 'text-ink-muted hover:text-foreground')}
                >
                  {value === 'tv' ? '4:3 TV' : '16:9'}
                </button>
              ))}
            </div>
          </div>
          {cut.notes ? (
            <section aria-label="Note" className="grid gap-1.5 border-t border-border pt-4">
              <h2 className="text-[13px] font-semibold text-foreground">Note</h2>
              <p className="text-[13px] leading-[20px] whitespace-pre-wrap text-ink-muted">{cut.notes}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </WorkbenchPanel>
  );
}
