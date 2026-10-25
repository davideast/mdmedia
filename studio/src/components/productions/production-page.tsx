'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Clapperboard, Play } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { studioJson } from '@/lib/media-client';
import { useMediaLinks } from '@/lib/use-media-links';
import { primeStudioResource, useStudioResource } from '@/lib/use-studio-resource';
import {
  castDetails,
  clockLength,
  labelDetail,
  newestFirst,
  shortLabel,
  statusPatch,
  type CastMember,
  type CutStatus,
  type ProductionCutSummary,
  type ProductionSummary,
} from '@/lib/productions';
import { Picture, StatusDot, StatusMenu } from './production-parts';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const cutHref = (productionId: string, cutId: string) => `/productions/${encodeURIComponent(productionId)}/cuts/${encodeURIComponent(cutId)}`;

/**
 * `/productions/{id}`: the production, its approved cut called out, and
 * every version newest first. A version's status is a small menu on its row;
 * approving a version makes it the approved cut.
 */
export function ProductionPage({ id }: { id: string }) {
  const path = `/api/v1/productions/${encodeURIComponent(id)}`;
  const { data: production, error, reload, update } = useStudioResource<ProductionSummary>(path);
  const [saving, setSaving] = useState<string | null>(null);
  const cuts = useMemo(() => (production ? newestFirst(production.cuts) : []), [production]);
  const cast = useMemo(() => production?.cast ?? [], [production]);
  const { links } = useMediaLinks(useMemo(() => [...cuts.map((cut) => cut.posterAssetId), ...cast.map((member) => member.stillAssetId)], [cuts, cast]));
  const picture = (cut: ProductionCutSummary) => (cut.posterAssetId ? links[cut.posterAssetId]?.thumbnail ?? links[cut.posterAssetId]?.content : null);

  const featured = production ? cuts.find((cut) => cut.id === production.approvedCutId) ?? cuts.find((cut) => cut.id === production.currentCutId) ?? cuts[0] : undefined;

  async function changeStatus(cut: ProductionCutSummary, status: CutStatus) {
    if (!production) return;
    const before = production;
    // Show the choice at once; the answer settles which cut is the approved one.
    update({
      ...production,
      approvedCutId: status === 'approved' || status === 'final' ? cut.id : production.approvedCutId === cut.id ? null : production.approvedCutId,
      cuts: production.cuts.map((item) => (item.id === cut.id ? { ...item, status } : item)),
    });
    setSaving(cut.id);
    try {
      const next = await studioJson<ProductionSummary>(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statusPatch(cut.id, status)) });
      update(next);
      primeStudioResource('/api/v1/productions', null);
    } catch (e) {
      update(before);
      toast.error(`Couldn't change ${shortLabel(cut.label)}: ${(e as Error).message}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <WorkbenchPanel workspacePage title={production?.title ?? 'Production'} icon={<Clapperboard size={13} strokeWidth={2} />} viewGrid gridVariant="wide">
      {!production && error ? (
        <div role="alert" className="grid justify-items-start gap-3 py-8 text-sm">
          <p className="text-destructive">{error}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
            <Button variant="ghost" size="sm" asChild><Link href="/productions">All productions</Link></Button>
          </div>
        </div>
      ) : !production ? (
        <p role="status" className="py-8 text-sm text-ink-muted">Loading production…</p>
      ) : (
        <div className="grid gap-10">
          <header className="grid gap-1">
            <p className="text-[13px] text-ink-muted">
              <Link href="/productions" className="hover:text-foreground hover:underline underline-offset-2">Productions</Link>
              {production.series ? <> <span aria-hidden className="px-1 text-ink-faint">/</span> {production.series.title}</> : null}
            </p>
            <h1 className="t-h2 text-foreground">{production.title}</h1>
          </header>

          {featured ? <Featured production={production} cut={featured} picture={picture(featured)} /> : null}

          {cast.length > 0 ? (
            <section aria-labelledby="cast-heading" className="grid gap-3">
              <h2 id="cast-heading" className="flex items-baseline gap-2">
                <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Cast</span>
                <span className="text-[13px] text-ink-muted">{cast.length} · the character versions it was made with</span>
              </h2>
              <ul className="grid border-t border-border sm:grid-cols-2 sm:gap-x-8">
                {cast.map((member) => (
                  <CastRow key={member.role} member={member} picture={member.stillAssetId ? links[member.stillAssetId]?.thumbnail ?? links[member.stillAssetId]?.content : null} />
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="versions-heading" className="grid gap-3">
            <h2 id="versions-heading" className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Versions</span>
              <span className="text-[13px] text-ink-muted">{production.cutCount} · newest first</span>
            </h2>
            <ol className="grid border-t border-border">
              {cuts.map((cut) => (
                <VersionRow
                  key={cut.id}
                  production={production}
                  cut={cut}
                  picture={picture(cut)}
                  saving={saving === cut.id}
                  onStatus={(status) => void changeStatus(cut, status)}
                />
              ))}
            </ol>
          </section>
        </div>
      )}
    </WorkbenchPanel>
  );
}

/** The cut to watch: the approved one, else the one the production shows first. */
function Featured({ production, cut, picture }: { production: ProductionSummary; cut: ProductionCutSummary; picture: string | null | undefined }) {
  const approved = cut.id === production.approvedCutId;
  const eyebrow = approved ? (cut.status === 'final' ? 'Final cut' : 'Approved cut') : 'Shown first';
  const detail = labelDetail(cut.label);
  return (
    <section aria-label={eyebrow} className="grid overflow-hidden rounded-[10px] border border-border bg-card sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Link href={cutHref(production.id, cut.id)} aria-label={`Open ${cut.label}`} className="group relative block focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset">
        <Picture src={picture} priority className="aspect-video sm:h-full sm:min-h-[16.5rem] sm:aspect-auto" />
        <span aria-hidden className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/20">
          <span className="grid size-12 place-items-center rounded-full bg-black/55 text-white opacity-90 backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <Play size={20} strokeWidth={2} className="ml-0.5 fill-current" />
          </span>
        </span>
      </Link>
      <div className="flex min-w-0 flex-col gap-3 p-4 sm:p-6">
        <p className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
          <StatusDot status={approved ? cut.status : 'none'} />
          {eyebrow}
        </p>
        <div className="grid gap-1">
          <h2 className="text-[20px] leading-[26px] font-semibold tracking-[-0.01em] text-foreground">{shortLabel(cut.label)}</h2>
          {detail ? <p className="text-[14px] text-foreground/80">{detail}</p> : null}
        </div>
        <p className="text-[12px] text-ink-muted tabular-nums">{[clockLength(cut.lengthSeconds), day(cut.createdAt), cut.kind === 'rendered' ? 'Video only' : null].filter(Boolean).join(' · ')}</p>
        {cut.notes ? <Note notes={cut.notes} truncated={cut.notesTruncated} lines={3} /> : null}
        <div className="mt-auto pt-1">
          <Button asChild size="sm">
            <Link href={cutHref(production.id, cut.id)}><Play size={14} className="fill-current" />Watch {shortLabel(cut.label)}</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function VersionRow({ production, cut, picture, saving, onStatus }: { production: ProductionSummary; cut: ProductionCutSummary; picture: string | null | undefined; saving: boolean; onStatus: (status: CutStatus) => void }) {
  const approved = cut.id === production.approvedCutId;
  const meta = [clockLength(cut.lengthSeconds), day(cut.createdAt), cut.kind === 'rendered' ? 'Video only' : null].filter(Boolean).join(' · ');
  return (
    <li className="relative grid grid-cols-[88px_minmax(0,1fr)] gap-4 border-b border-border py-4 sm:grid-cols-[128px_minmax(0,1fr)] sm:gap-5">
      {/* The whole row opens the version; the status menu sits above the link. */}
      <Link href={cutHref(production.id, cut.id)} aria-label={`Open ${cut.label}`} className="absolute inset-0 rounded-[6px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden" />
      <Picture src={picture} className={cn('pointer-events-none self-start rounded-[6px]', approved && 'ring-1 ring-[#2f9e44]/60 dark:ring-[#3fb950]/60')} />
      {/* Label, status, meta and note on one small grid: the status sits beside the label, or beside the meta on a phone. */}
      <div className="pointer-events-none grid min-w-0 grid-cols-[minmax(0,1fr)_auto] content-start items-center gap-x-3 gap-y-1.5">
        <p className="col-span-2 min-w-0 text-[14px] leading-[20px] font-semibold text-foreground sm:col-span-1">
          <span>{shortLabel(cut.label)}</span>
          {labelDetail(cut.label) ? <span className="font-normal text-foreground/75"> · {labelDetail(cut.label)}</span> : null}
        </p>
        <span className="pointer-events-auto relative z-10 col-start-2 row-start-2 sm:row-start-1">
          <StatusMenu status={cut.status} label={cut.label} disabled={saving} onChange={onStatus} />
        </span>
        <p className="col-start-1 row-start-2 min-w-0 truncate text-[12px] text-ink-muted tabular-nums">
          {meta}
          {approved ? <span className="text-foreground/80"> · {cut.status === 'final' ? 'Final cut' : 'Approved cut'}</span> : null}
        </p>
        {cut.notes ? <span className="pointer-events-auto relative z-10 col-span-2 w-fit max-w-full"><Note notes={cut.notes} truncated={cut.notesTruncated} lines={2} href={cutHref(production.id, cut.id)} /></span> : null}
      </div>
    </li>
  );
}

/** One part in the cast: the character's reference still, its name and role, the version, voice and how it speaks. */
function CastRow({ member, picture }: { member: CastMember; picture: string | null | undefined }) {
  return (
    <li className="grid grid-cols-[88px_minmax(0,1fr)] gap-4 border-b border-border py-4">
      <Picture src={picture} alt={`${member.name}, reference still`} className="self-start rounded-[6px]" />
      <div className="grid min-w-0 content-start gap-1">
        <p className="min-w-0 text-[14px] leading-[20px] font-semibold text-foreground">
          <span>{member.name}</span>
          {member.role !== member.name ? <span className="font-normal text-foreground/75"> as {member.role}</span> : null}
        </p>
        <p className="min-w-0 text-[12px] leading-[18px] text-ink-muted tabular-nums" title={member.ref}>{castDetails(member)}</p>
        {member.register ? <p className="line-clamp-2 text-[13px] leading-[20px] text-ink-muted">{member.register}</p> : null}
      </div>
    </li>
  );
}

/** A review note, clamped; the whole note on hover or focus. In a row it also opens the version, like the rest of the row. */
function Note({ notes, truncated, lines, href }: { notes: string; truncated: boolean; lines: 2 | 3; href?: string }) {
  const className = cn('block text-[13px] leading-[20px] text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-ring', lines === 2 ? 'line-clamp-2' : 'line-clamp-2 sm:line-clamp-3');
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        {href ? <Link href={href} tabIndex={-1} className={className}>{notes}</Link> : <p tabIndex={0} className={className}>{notes}</p>}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[min(32rem,calc(100vw-2rem))] text-[12.5px] leading-[19px] whitespace-pre-wrap">
        {notes}
        {truncated ? <span className="mt-1 block opacity-70">The full note is with the version.</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
