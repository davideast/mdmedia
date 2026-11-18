"use client";

import { cn } from "cn";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  EyeOff,
  ImageOff,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { usePrivateMedia } from "@/components/media/private-media";
import { resolvePrivateMediaContentPath } from "@/components/reader/document-media-card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  countItems,
  DEFAULT_GALLERY_FILTERS,
  filterGallery,
  isDefaultFilters,
  madeFacts,
  originLabel,
  parseGalleryBlock,
  presentFacets,
  REVIEW_LABELS,
  stepItem,
  toggleValue,
  VERDICT_LABELS,
  verdictLabel,
  visibleItemOrder,
  type GalleryBlock as GalleryBlockData,
  type GalleryFilters,
  type GalleryItem,
  type GalleryVerdict,
  type GalleryVerdictFilterValue,
} from "@/lib/gallery-block";
import { parseMediaUri } from "@/lib/markdown-word-aligner";
import type { TreeMediaRef } from "@/lib/tree-types";

/** How a link inside the gallery resolves, as the reader resolves any link in the document. */
export interface GalleryResolvedHref {
  href: string | null;
  isInternalDoc: boolean;
}

export interface GalleryBlockProps {
  /** The fence body: the gallery's JSON. */
  source: string;
  pathAssets: Record<string, TreeMediaRef>;
  /** The path of the document that holds the block; gallery paths are relative to it. */
  docPath: string;
  /** Resolves a relative doc path (or URL) the same way the reader resolves Markdown links. */
  resolveHref: (rawHref: string) => GalleryResolvedHref;
  /** Navigates inside the tree to a resolved doc href, without a page load. */
  onNavigateDocHref?: (resolvedHref: string) => void;
  /** Rendered, under a one-line notice, when the body cannot be read as a gallery. */
  fallback: ReactNode;
}

export function GalleryBlock({
  source,
  pathAssets,
  docPath,
  resolveHref,
  onNavigateDocHref,
  fallback,
}: GalleryBlockProps) {
  const parsed = useMemo(() => parseGalleryBlock(source), [source]);
  if (!parsed.ok) {
    return (
      <div data-gallery-block="invalid" className="grid min-w-0 gap-2">
        <p role="note" className="text-xs text-ink-muted">
          {parsed.reason}
        </p>
        {fallback}
      </div>
    );
  }
  return (
    <GalleryView
      block={parsed.block}
      pathAssets={pathAssets}
      docPath={docPath}
      resolveHref={resolveHref}
      onNavigateDocHref={onNavigateDocHref}
    />
  );
}

interface GalleryContext {
  pathAssets: Record<string, TreeMediaRef>;
  docPath: string;
  resolveHref: (rawHref: string) => GalleryResolvedHref;
  onNavigateDocHref?: (resolvedHref: string) => void;
}

function GalleryView({
  block,
  ...context
}: GalleryContext & { block: GalleryBlockData }) {
  const [filters, setFilters] = useState<GalleryFilters>(DEFAULT_GALLERY_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const headingPrefix = useId();

  const facets = useMemo(() => presentFacets(block), [block]);
  const total = useMemo(() => countItems(block), [block]);
  const rows = useMemo(() => filterGallery(block, filters), [block, filters]);
  const order = useMemo(() => visibleItemOrder(rows), [rows]);
  const shown = order.length;

  const openItem = openId ? order.find((item) => item.key === openId) ?? null : null;
  const openGroup = openItem
    ? rows.find((row) => row.items.some((item) => item.key === openItem.key))?.group ?? null
    : null;

  const toggleVerdict = (value: GalleryVerdictFilterValue) =>
    setFilters((prev) => {
      const verdicts = toggleValue(prev.verdicts, value);
      // Asking for rejected items by name turns "Hide rejected" off, so the chips agree.
      const hideRejected =
        value === "rejected" && verdicts.includes("rejected") ? false : prev.hideRejected;
      return { ...prev, verdicts, hideRejected };
    });

  return (
    <section
      data-gallery-block="ready"
      aria-label={block.title ?? "Gallery"}
      className="reader-block grid min-w-0 gap-5"
    >
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {block.title ? (
          <h2 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
            {block.title}
          </h2>
        ) : (
          <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint">
            Gallery
          </span>
        )}
        <span
          data-gallery-count={shown}
          className="font-mono text-[11px] uppercase tracking-wider text-ink-faint"
        >
          {shown === total ? `${total} images` : `${shown} of ${total} images`}
        </span>
      </header>

      <div
        role="group"
        aria-label="Filter the gallery"
        data-gallery-filters="true"
        className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface-inset/40 p-3"
      >
        <FilterRow label="Direction">
          <Chip
            kind="direction"
            value="all"
            active={filters.groups.length === 0}
            onClick={() => setFilters((prev) => ({ ...prev, groups: [] }))}
          >
            All
          </Chip>
          {block.groups.map((group) => (
            <Chip
              key={group.id}
              kind="direction"
              value={group.id}
              active={filters.groups.includes(group.id)}
              onClick={() =>
                setFilters((prev) => ({ ...prev, groups: toggleValue(prev.groups, group.id) }))
              }
            >
              {group.title}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="Made by">
          <Chip
            kind="origin"
            value="all"
            active={filters.origins.length === 0}
            onClick={() => setFilters((prev) => ({ ...prev, origins: [] }))}
          >
            All
          </Chip>
          {facets.origins.map((origin) => (
            <Chip
              key={origin}
              kind="origin"
              value={origin}
              active={filters.origins.includes(origin)}
              onClick={() =>
                setFilters((prev) => ({ ...prev, origins: toggleValue(prev.origins, origin) }))
              }
            >
              {originLabel(origin)}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="Verdict">
          <Chip
            kind="verdict"
            value="all"
            active={filters.verdicts.length === 0}
            onClick={() => setFilters((prev) => ({ ...prev, verdicts: [] }))}
          >
            All
          </Chip>
          {facets.verdicts.map((verdict) => (
            <Chip
              key={verdict}
              kind="verdict"
              value={verdict}
              active={filters.verdicts.includes(verdict)}
              onClick={() => toggleVerdict(verdict)}
            >
              {VERDICT_LABELS[verdict]}
            </Chip>
          ))}
        </FilterRow>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={filters.hideRejected}
            data-gallery-filter="hide-rejected"
            onClick={() => setFilters((prev) => ({ ...prev, hideRejected: !prev.hideRejected }))}
            className={cn(chipClass(filters.hideRejected), "gap-1.5")}
          >
            <EyeOff size={12} aria-hidden="true" />
            <span>Hide rejected</span>
          </button>
          {!isDefaultFilters(filters) ? (
            <button
              type="button"
              data-gallery-clear-filters="true"
              onClick={() => setFilters(DEFAULT_GALLERY_FILTERS)}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-ink-muted underline decoration-border-strong underline-offset-4 transition-colors hover:text-foreground cursor-pointer"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <div
          data-gallery-empty="true"
          className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border p-5 text-sm text-ink-muted"
        >
          <p>No images match these filters.</p>
          <button
            type="button"
            data-gallery-clear-filters="true"
            onClick={() => setFilters(DEFAULT_GALLERY_FILTERS)}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted cursor-pointer"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid min-w-0 gap-7">
          {rows.map(({ group, items }) => (
            <section
              key={group.id}
              data-gallery-group={group.id}
              aria-labelledby={`${headingPrefix}-${group.id}`}
              className="grid min-w-0 gap-3"
            >
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3
                    id={`${headingPrefix}-${group.id}`}
                    className="text-base font-semibold leading-snug text-foreground"
                  >
                    {group.title}
                  </h3>
                  {group.href ? (
                    <GalleryLink
                      raw={group.href}
                      context={context}
                      data-gallery-read-more="true"
                      className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-foreground"
                    >
                      <span>Read more</span>
                      <ArrowRight size={12} aria-hidden="true" />
                    </GalleryLink>
                  ) : null}
                </div>
                {group.summary ? (
                  <p className="text-sm leading-snug text-ink-muted">{group.summary}</p>
                ) : null}
              </div>
              <ul
                aria-label={`${group.title} images`}
                className="flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:thin]"
              >
                {items.map((item) => (
                  <li key={item.key} className="flex shrink-0 snap-start">
                    <GalleryCard
                      item={item}
                      context={context}
                      onOpen={() => setOpenId(item.key)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Dialog
        open={openItem !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        {openItem ? (
          <GalleryLightbox
            item={openItem}
            groupTitle={openGroup?.title ?? null}
            position={order.findIndex((item) => item.key === openItem.key) + 1}
            count={order.length}
            prev={stepItem(order, openItem.key, -1)}
            next={stepItem(order, openItem.key, 1)}
            onSelect={setOpenId}
            onClose={() => setOpenId(null)}
            context={context}
          />
        ) : null}
      </Dialog>
    </section>
  );
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-baseline">
      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </span>
      <div className="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0 [&>*]:whitespace-nowrap sm:flex-wrap sm:overflow-visible">{children}</div>
    </div>
  );
}

function chipClass(active: boolean): string {
  return cn(
    "inline-flex h-7 max-w-full items-center rounded-full border px-2.5 text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "border-foreground bg-foreground font-medium text-background"
      : "border-border bg-surface-card text-ink-muted hover:border-border-strong hover:text-foreground",
  );
}

function Chip({
  kind,
  value,
  active,
  onClick,
  children,
}: {
  kind: "direction" | "origin" | "verdict";
  value: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-gallery-filter={kind}
      data-value={value}
      onClick={onClick}
      className={chipClass(active)}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

const VERDICT_TONE: Record<GalleryVerdictFilterValue, string> = {
  accepted: "text-mint",
  "awaiting-feedback": "text-ink-muted",
  "revision-requested": "text-coral",
  rejected: "text-destructive",
  none: "text-ink-faint",
};

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center rounded-full border border-border bg-surface-inset px-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function VerdictPill({ verdict }: { verdict: GalleryVerdict | null }) {
  return (
    <Pill className={VERDICT_TONE[verdict ?? "none"]}>{verdictLabel(verdict)}</Pill>
  );
}

/**
 * An image in the gallery, loaded through the authenticated media path.
 * Thumbnails come from the asset's 480px preview and fall back to the full
 * file when the asset has none. Nothing loads until `enabled`.
 */
function useGalleryImage(
  image: string | null,
  context: GalleryContext,
  variant: "thumbnail" | "full",
  enabled: boolean,
): { url: string; error: string; resolved: boolean } {
  const ref = image ? parseMediaUri(image, context.pathAssets, context.docPath) : null;
  const fullPath = ref ? resolvePrivateMediaContentPath(ref) : null;
  const thumbPath =
    variant === "thumbnail" && fullPath && (ref?.type === "asset" || ref?.type === "image")
      ? `${fullPath}?thumbnail=1`
      : null;
  const thumb = usePrivateMedia(enabled ? thumbPath : null);
  const needFull = enabled && (thumbPath === null || thumb.error !== "");
  const full = usePrivateMedia(needFull ? fullPath : null);
  const url = thumb.url || full.url;
  const error = url ? "" : thumbPath && !thumb.error ? "" : full.error;
  return { url, error, resolved: fullPath !== null };
}

/** True once the element has come near the viewport. Without IntersectionObserver, true at once. */
function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
}

function GalleryCard({
  item,
  context,
  onOpen,
}: {
  item: GalleryItem;
  context: GalleryContext;
  onOpen: () => void;
}) {
  const { ref, near } = useNearViewport<HTMLButtonElement>();
  const { url, error, resolved } = useGalleryImage(item.image, context, "thumbnail", near);
  return (
    <button
      ref={ref}
      type="button"
      data-gallery-item={item.id}
      data-gallery-item-key={item.key}
      data-origin={item.origin}
      data-verdict={item.verdict ?? "none"}
      aria-label={`${item.title}: ${originLabel(item.origin)}, ${verdictLabel(item.verdict)}`}
      onClick={onOpen}
      className="grid w-40 content-start gap-2 overflow-hidden rounded-lg border border-border bg-surface-card p-2 text-left shadow-2xs transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-zoom-in sm:w-44"
    >
      <span className="grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-md bg-surface-inset">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            draggable={false}
            data-gallery-image="thumbnail"
            className="h-full w-full object-cover"
          />
        ) : !resolved || error ? (
          <span className="grid justify-items-center gap-1 p-2 text-center text-[11px] leading-snug text-ink-faint">
            <ImageOff size={16} aria-hidden="true" />
            <span>{resolved ? "Image unavailable" : "Image not in this tree"}</span>
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {item.title}
      </span>
      <span className="flex min-w-0 flex-wrap gap-1">
        <Pill>{originLabel(item.origin)}</Pill>
        <VerdictPill verdict={item.verdict} />
      </span>
    </button>
  );
}

const isPlainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;

/**
 * A link written in the gallery, resolved like any link in the document.
 * Doc links navigate inside the tree; anything else opens in a new tab. A
 * path that resolves to nothing is shown as plain text.
 */
function GalleryLink({
  raw,
  context,
  onNavigated,
  className,
  children,
  ...data
}: {
  raw: string;
  context: GalleryContext;
  onNavigated?: () => void;
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  const { href, isInternalDoc } = context.resolveHref(raw);
  if (!href) {
    return (
      <span
        {...data}
        data-unresolved-link={raw}
        title={raw}
        className={cn(className, "decoration-dotted underline underline-offset-4")}
      >
        {children}
      </span>
    );
  }
  const navigate = context.onNavigateDocHref;
  return (
    <a
      {...data}
      href={href}
      target={isInternalDoc ? undefined : "_blank"}
      rel={isInternalDoc ? undefined : "noopener noreferrer"}
      onClick={
        isInternalDoc && navigate
          ? (event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onNavigated?.();
              navigate(href);
            }
          : undefined
      }
      className={className}
    >
      {children}
    </a>
  );
}

function GalleryLightbox({
  item,
  groupTitle,
  position,
  count,
  prev,
  next,
  onSelect,
  onClose,
  context,
}: {
  item: GalleryItem;
  groupTitle: string | null;
  position: number;
  count: number;
  prev: GalleryItem | null;
  next: GalleryItem | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  context: GalleryContext;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowLeft" && prev) {
      event.preventDefault();
      onSelect(prev.key);
    } else if (event.key === "ArrowRight" && next) {
      event.preventDefault();
      onSelect(next.key);
    }
  };

  const navButton =
    "inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-surface-inset text-ink-muted transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 cursor-pointer";

  return (
    <DialogContent
      showCloseButton={false}
      aria-describedby={undefined}
      onKeyDown={handleKeyDown}
      data-gallery-lightbox="true"
      data-gallery-item-id={item.id}
      data-gallery-item-key={item.key}
      overlayClassName="bg-black/90 backdrop-blur-md"
      className="fixed inset-0 z-50 flex h-dvh w-dvw max-h-none max-w-none top-0 left-0 translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-surface-card px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-gallery-position={position}
            className="shrink-0 font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint"
          >
            {position} of {count}
          </span>
          <span className="truncate text-xs text-foreground">{groupTitle ?? item.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous image"
            data-gallery-prev="true"
            disabled={!prev}
            onClick={() => prev && onSelect(prev.key)}
            className={navButton}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            aria-label="Next image"
            data-gallery-next="true"
            disabled={!next}
            onClick={() => next && onSelect(next.key)}
            className={navButton}
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            aria-label="Close"
            data-gallery-lightbox-close="true"
            onClick={onClose}
            className={cn(navButton, "hover:bg-destructive/10 hover:text-destructive")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        key={item.key}
        data-gallery-lightbox-body="true"
        className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
      >
        <LightboxImage item={item} context={context} />
        <LightboxPanel item={item} context={context} onClose={onClose} />
      </div>
    </DialogContent>
  );
}

function LightboxImage({ item, context }: { item: GalleryItem; context: GalleryContext }) {
  const preview = useGalleryImage(item.image, context, "thumbnail", true);
  const full = useGalleryImage(item.image, context, "full", true);
  const url = full.url || preview.url;
  return (
    <div className="grid min-h-[12rem] place-items-center bg-surface-inset p-4 lg:min-h-0">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={item.caption ?? item.title}
          data-gallery-image={full.url ? "full" : "preview"}
          className="max-h-[70dvh] max-w-full rounded-md object-contain shadow-lg lg:max-h-[calc(100dvh-5rem)]"
        />
      ) : (
        <span className="grid justify-items-center gap-1 text-center text-xs text-ink-faint">
          {!full.resolved || full.error ? <ImageOff size={18} aria-hidden="true" /> : null}
          <span>
            {!full.resolved
              ? "This image is not in this tree."
              : full.error
                ? "Image unavailable."
                : "Loading image"}
          </span>
        </span>
      )}
    </div>
  );
}

function PanelSection({
  title,
  name,
  children,
}: {
  title: string;
  name: string;
  children: ReactNode;
}) {
  return (
    <section data-gallery-section={name} className="grid min-w-0 gap-3">
      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

const panelLink =
  "underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary";

function LightboxPanel({
  item,
  context,
  onClose,
}: {
  item: GalleryItem;
  context: GalleryContext;
  onClose: () => void;
}) {
  const made = item.made;
  return (
    <aside
      data-gallery-panel="true"
      className="grid min-w-0 content-start gap-7 border-t border-border bg-surface-card p-5 lg:overflow-y-auto lg:border-t-0 lg:border-l"
    >
      <div className="grid min-w-0 gap-2">
        <DialogTitle className="text-lg font-semibold leading-snug">{item.title}</DialogTitle>
        <div className="flex flex-wrap gap-1">
          <Pill>{originLabel(item.origin)}</Pill>
          <VerdictPill verdict={item.verdict} />
          {item.review ? <Pill>{REVIEW_LABELS[item.review]}</Pill> : null}
        </div>
      </div>

      <PanelSection title="How it was made" name="made">
        {made.summary ? <p className="text-sm text-foreground">{made.summary}</p> : null}
        <div className="grid min-w-0 gap-1.5">
          <span className="text-sm text-ink-muted">Prompt</span>
          {made.prompt ? (
            <p
              data-gallery-prompt="true"
              className="whitespace-pre-wrap rounded-md border border-border bg-surface-inset p-3 font-mono text-xs leading-relaxed text-foreground"
            >
              {made.prompt}
            </p>
          ) : (
            <p data-gallery-prompt="none" className="text-sm text-ink-faint">
              Not recorded
            </p>
          )}
          {made.promptBasis ? (
            <p className="text-xs text-ink-faint">{made.promptBasis}</p>
          ) : null}
        </div>
        <dl className="grid min-w-0 gap-2">
          {madeFacts(made).map((fact) => (
            <Fact key={fact.label} label={fact.label}>
              <span className={fact.recorded ? undefined : "text-ink-faint"}>{fact.value}</span>
            </Fact>
          ))}
          {made.settings.map((setting, index) => (
            <Fact key={`${setting.label}-${index}`} label={setting.label}>
              {setting.value}
            </Fact>
          ))}
          {made.parent ? (
            <Fact label="Revised from">
              {made.parent.href ? (
                <GalleryLink
                  raw={made.parent.href}
                  context={context}
                  onNavigated={onClose}
                  className={panelLink}
                >
                  {made.parent.title}
                </GalleryLink>
              ) : (
                made.parent.title
              )}
            </Fact>
          ) : null}
          {made.source ? (
            <Fact label="Source">
              <a
                href={made.source.url}
                target="_blank"
                rel="noopener noreferrer"
                data-gallery-source="true"
                className={cn(panelLink, "inline-flex items-baseline gap-1")}
              >
                <span>{made.source.label}</span>
                <ExternalLink size={11} aria-hidden="true" className="shrink-0 self-center" />
              </a>
            </Fact>
          ) : null}
        </dl>
        {made.references.length > 0 ? (
          <div className="grid min-w-0 gap-2">
            <span className="text-sm text-ink-muted">References</span>
            <ul className="grid min-w-0 gap-2">
              {made.references.map((reference, index) => (
                <li
                  key={`${reference.label}-${index}`}
                  className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-center gap-3"
                >
                  <ReferenceThumbnail image={reference.image} context={context} />
                  <span className="grid min-w-0 text-sm">
                    <span className="truncate text-foreground">{reference.label}</span>
                    {reference.role ? (
                      <span className="text-xs text-ink-muted">{reference.role}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {made.records.length > 0 ? (
          <div className="grid min-w-0 gap-1.5">
            <span className="text-sm text-ink-muted">Retained records</span>
            <ul className="grid min-w-0 gap-1 text-sm">
              {made.records.map((record, index) => (
                <li key={`${record.label}-${index}`} className="min-w-0 truncate">
                  {record.href ? (
                    <GalleryLink
                      raw={record.href}
                      context={context}
                      onNavigated={onClose}
                      data-gallery-record="true"
                      className={panelLink}
                    >
                      {record.label}
                    </GalleryLink>
                  ) : (
                    <span className="text-foreground">{record.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {made.note ? <p className="text-xs text-ink-muted">{made.note}</p> : null}
      </PanelSection>

      <PanelSection title="What we see" name="caption">
        <p className={cn("text-sm", item.caption ? "text-foreground" : "text-ink-faint")}>
          {item.caption ?? "No observation recorded yet."}
        </p>
      </PanelSection>

      <PanelSection title="Your feedback" name="feedback">
        <p
          className={cn(
            "whitespace-pre-wrap text-sm",
            item.feedback ? "text-foreground" : "text-ink-faint",
          )}
        >
          {item.feedback ?? "No feedback recorded."}
        </p>
      </PanelSection>

      {item.href ? (
        <GalleryLink
          raw={item.href}
          context={context}
          onNavigated={onClose}
          data-gallery-go-deeper="true"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <span>Go deeper</span>
          <ArrowRight size={14} aria-hidden="true" />
        </GalleryLink>
      ) : null}
    </aside>
  );
}

function ReferenceThumbnail({ image, context }: { image: string | null; context: GalleryContext }) {
  const { url } = useGalleryImage(image, context, "thumbnail", image !== null);
  return (
    <span className="grid size-12 place-items-center overflow-hidden rounded-md border border-border bg-surface-inset">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <ImageOff size={14} aria-hidden="true" className="text-ink-faint" />
      )}
    </span>
  );
}
