"use client";
import { useState } from "react";
import type { Assembly, AssemblyDraft } from "mdmedia/assembly";
import { InspectorContent } from "@/components/shell/inspector-slot";
import { useOptionalShell } from "@/components/shell/shell-context";
import { useStudioResource } from "@/lib/use-studio-resource";
import type { ProductionAssetResource } from "@/lib/production-media-server";

type Assets = Record<string, ProductionAssetResource>;
export function AssemblyOutline({
  document,
  onSelect,
}: {
  document: Assembly;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid min-w-0 gap-6">
      <section aria-label="Scenes">
        <ol className="divide-y divide-border border-y border-border">
          {document.scenes.map((scene, i) => (
            <li key={scene.id}>
              <button
                type="button"
                onClick={() => onSelect(scene.id)}
                className="flex w-full gap-4 px-2 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="text-ink-muted tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{scene.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

    </div>
  );
}
export function AssemblyDetails({
  document,
  selected,
  assets,
}: {
  document: Assembly;
  selected: string | null;
  assets: Assets;
}) {
  const placement = document.placements.find((p) => p.id === selected);
  const scene = document.scenes.find(
    (s) => s.id === (placement?.sceneId ?? selected),
  );
  const placements = placement
    ? [placement]
    : scene
      ? document.placements.filter((p) => p.sceneId === scene.id)
      : [];
  return (
    <section aria-label="Assembly details" className="grid gap-4 text-[13px] leading-5 text-foreground">
      {scene ? (
        <>
          <h2 className="t-label">{scene.title}</h2>
          {scene.script ? (
            <p className="whitespace-pre-wrap">{scene.script}</p>
          ) : null}
          {scene.visual ? (
            <p className="whitespace-pre-wrap text-ink-muted">{scene.visual}</p>
          ) : null}
          {scene.notes ? (
            <p className="whitespace-pre-wrap">{scene.notes}</p>
          ) : null}
        </>
      ) : null}
      {placements.map((placement) => {
        const asset = assets[placement.assetId];
        return (
          <div key={placement.id} className="grid gap-3">
            <h3 className="t-label">{placement.id}</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt>Track</dt>
              <dd>
                {document.tracks.find((t) => t.id === placement.trackId)?.name}
              </dd>
              <dt>Timeline</dt>
              <dd>
                {placement.start}–
                {placement.start + placement.out - placement.in}s
              </dd>
              <dt>Source</dt>
              <dd>
                {placement.in}–{placement.out}s
              </dd>
              <dt>Asset</dt>
              <dd className="break-all">{placement.assetId}</dd>
              {asset ? (
                <>
                  <dt>Media</dt>
                  <dd>{asset.mimeType}</dd>
                </>
              ) : null}
            </dl>
          </div>
        );
      })}
    </section>
  );
}
export function ProductionAssemblyDraft({
  productionId,
}: {
  productionId: string;
}) {
  const { data, error } = useStudioResource<AssemblyDraft & { assets: Assets }>(
    `/api/v1/productions/${encodeURIComponent(productionId)}/assembly`,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const shell = useOptionalShell();
  if (error) return <p role="alert">{error}</p>;
  if (!data) return null;
  return (
    <section aria-label="Production draft" className="grid gap-4">
      <h2 className="t-label">Draft</h2>
      <AssemblyOutline
        document={data.document}
        onSelect={(id) => {
          setSelected(id);
          shell?.openContext();
        }}
      />
      <InspectorContent>
        <AssemblyDetails
          document={data.document}
          selected={selected}
          assets={data.assets}
        />
      </InspectorContent>
    </section>
  );
}
