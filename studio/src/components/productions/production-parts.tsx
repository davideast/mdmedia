'use client';

import { useState } from 'react';
import { Check, ChevronDown, Clapperboard } from 'lucide-react';
import { cn } from 'cn';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { STATUS_LABELS, STATUS_ORDER, type CutStatus } from '@/lib/productions';

/**
 * The small pieces the production pages share: a 4:3 picture that loads
 * lazily from a signed link, the status dot and pill in the review page's
 * colours, and the status menu a version row uses.
 */

/** Amber for review, green for approved and final, grey for no verdict: the review page's colours. */
const DOT: Record<CutStatus, string> = {
  review: 'bg-[#e3a008] dark:bg-[#f5a524]',
  approved: 'bg-[#2f9e44] dark:bg-[#3fb950]',
  final: 'bg-[#2f9e44] dark:bg-[#3fb950]',
  none: 'bg-ink-faint',
};

export function StatusDot({ status, className }: { status: CutStatus; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 flex-none rounded-full', DOT[status], className)} />;
}

/** A status as quiet text with its dot. */
export function StatusPill({ status, className }: { status: CutStatus; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 flex-none items-center gap-1.5 rounded-full border border-border px-2.5 text-[12px] leading-none font-medium whitespace-nowrap text-foreground/85', className)}>
      <StatusDot status={status} />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** The status pill as a menu: pick a verdict for this version. */
export function StatusMenu({ status, label, disabled, onChange }: { status: CutStatus; label: string; disabled?: boolean; onChange: (status: CutStatus) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Status of ${label}: ${STATUS_LABELS[status]}. Change`}
        className="group inline-flex h-7 flex-none items-center gap-1.5 rounded-full border border-border pr-2 pl-2.5 text-[12px] leading-none font-medium whitespace-nowrap text-foreground/85 transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden disabled:opacity-60 data-[state=open]:bg-muted"
      >
        <StatusDot status={status} />
        {STATUS_LABELS[status]}
        <ChevronDown size={13} strokeWidth={2} className="-mr-0.5 text-ink-muted transition-transform group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {STATUS_ORDER.map((value) => (
          <DropdownMenuItem key={value} onSelect={() => { if (value !== status) onChange(value); }} className="gap-2.5">
            <StatusDot status={value} />
            <span className="flex-1">{STATUS_LABELS[value]}</span>
            {value === status ? <Check size={14} className="text-ink-muted" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A 4:3 picture, the TV's frame, from a signed link. It loads lazily and
 * fades in; until then, and when there is none, a quiet placeholder holds
 * the same box so nothing moves.
 */
export function Picture({ src, alt = '', className, priority = false }: { src: string | null | undefined; alt?: string; className?: string; priority?: boolean }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <span className={cn('relative block aspect-[4/3] overflow-hidden bg-foreground/[0.06]', className)}>
      {src ? (
        // A signed private link; Next's image optimiser can't fetch it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(src)}
          className={cn('absolute inset-0 h-full w-full object-cover transition-opacity duration-300', loaded === src ? 'opacity-100' : 'opacity-0')}
        />
      ) : (
        <Clapperboard aria-hidden size={20} strokeWidth={1.5} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-ink-faint" />
      )}
    </span>
  );
}
