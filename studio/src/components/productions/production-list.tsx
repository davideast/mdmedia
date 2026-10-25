'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WorkbenchPanel } from '@/components/shell/workbench-panel';
import { useMediaLinks } from '@/lib/use-media-links';
import { useStudioResource } from '@/lib/use-studio-resource';
import { latestCut, productionPicture, productionSections, productionStatus, shortLabel, versionCount, type ProductionList, type ProductionSummary } from '@/lib/productions';
import { Picture, StatusPill } from './production-parts';

/**
 * `/productions`: your productions as cards, each series under its own
 * heading and the rest under Standalone, most recent activity first. Only
 * pictures load here, lazily, from signed links; no video.
 */
export function ProductionListPage() {
  const { data, error, reload } = useStudioResource<ProductionList>('/api/v1/productions');
  const sections = useMemo(() => (data ? productionSections(data) : []), [data]);
  const pictures = useMemo(() => (data?.productions ?? []).map(productionPicture), [data]);
  const { links } = useMediaLinks(pictures);

  return (
    <WorkbenchPanel workspacePage title="Productions" icon={<Clapperboard size={13} strokeWidth={2} />} viewGrid gridVariant="wide">
      {!data && error ? (
        <div role="alert" className="grid justify-items-start gap-3 py-8 text-sm">
          <p className="text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
        </div>
      ) : !data ? (
        <ProductionGridSkeleton />
      ) : data.productions.length === 0 ? (
        <EmptyProductions />
      ) : (
        <div className="grid gap-10">
          {sections.map((section) => (
            <section key={section.id ?? 'standalone'} aria-labelledby={`section-${section.id ?? 'standalone'}`} className="grid gap-4">
              <h2 id={`section-${section.id ?? 'standalone'}`} className="flex items-baseline gap-2">
                <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{section.title}</span>
                <span className="text-[13px] text-ink-muted">{section.id ? `Series · ${section.productions.length}` : section.productions.length}</span>
              </h2>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
                {section.productions.map((production) => {
                  const picture = productionPicture(production);
                  return <ProductionCard key={production.id} production={production} picture={picture ? links[picture]?.thumbnail ?? links[picture]?.content : null} />;
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </WorkbenchPanel>
  );
}

function ProductionCard({ production, picture }: { production: ProductionSummary; picture: string | null | undefined }) {
  const latest = latestCut(production);
  // The newest version, and how many there are when there's more than one.
  const meta = [latest ? shortLabel(latest.label) : null, production.cutCount > 1 ? versionCount(production.cutCount) : null].filter(Boolean).join(' · ') || versionCount(production.cutCount);
  return (
    <li className="min-w-0">
      {/* On a phone a card is a row: the picture beside the words. From sm up, the picture sits on top. */}
      <Link
        href={`/productions/${encodeURIComponent(production.id)}`}
        className="group grid grid-cols-[112px_minmax(0,1fr)] items-center gap-4 rounded-[10px] p-2 -mx-2 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden sm:mx-0 sm:block sm:overflow-hidden sm:border sm:border-border sm:bg-card sm:p-0 sm:hover:border-border-strong sm:hover:bg-card"
      >
        <Picture src={picture} className="rounded-[6px] sm:rounded-none" />
        <span className="grid min-w-0 gap-2 sm:px-4 sm:pt-3 sm:pb-4">
          <span className="line-clamp-2 text-[14px] leading-[20px] font-semibold text-foreground sm:truncate sm:whitespace-nowrap">{production.title}</span>
          {/* A phone stacks the pill over the meta; wider cards keep them on one line. */}
          <span className="flex min-w-0 flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <StatusPill status={productionStatus(production)} />
            <span className="max-w-full min-w-0 truncate text-[12px] text-ink-muted" title={meta}>{meta}</span>
          </span>
        </span>
      </Link>
    </li>
  );
}

function ProductionGridSkeleton() {
  return (
    <div role="status" aria-label="Loading productions" className="grid gap-4">
      <span className="h-5 w-32 rounded bg-foreground/[0.06]" />
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="grid grid-cols-[112px_1fr] items-center gap-4 p-2 sm:block sm:overflow-hidden sm:rounded-[10px] sm:border sm:border-border sm:p-0">
            <span className="block aspect-[4/3] animate-pulse rounded-[6px] bg-foreground/[0.06] sm:rounded-none" />
            <span className="grid gap-2 sm:px-4 sm:pt-3 sm:pb-4">
              <span className="h-4 w-3/4 rounded bg-foreground/[0.06]" />
              <span className="h-6 w-1/2 rounded bg-foreground/[0.04]" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyProductions() {
  return (
    <div className="grid justify-items-center gap-3 rounded-[10px] border border-dashed border-border px-6 py-16 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-foreground/[0.06] text-ink-muted"><Clapperboard size={20} strokeWidth={1.75} /></span>
      <p className="text-[15px] font-semibold text-foreground">No productions yet</p>
      <p className="max-w-[44ch] text-[13px] leading-[20px] text-ink-muted">
        Episodes and commercials appear here once they&apos;re pushed. From the repository, run{' '}
        <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[12px] text-foreground">mdmedia production push</code>{' '}
        with a production manifest.
      </p>
    </div>
  );
}
