"use client";

import Image from "next/image";
import { useRef, useState, type ReactNode } from "react";
import { Maximize2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import "./media-preview.css";

/** Stills and generated media share a monitor, without pretending an image is a video. */
export function MediaPreview({ imageSrc, videoSrc, alt, label, caption, compact = false, empty, actions, onVideoDuration }: {
  imageSrc?: string;
  videoSrc?: string;
  alt: string;
  label: string;
  caption: string;
  compact?: boolean;
  empty?: ReactNode;
  actions?: ReactNode;
  onVideoDuration?: (seconds: number) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const failed = failedSource === (videoSrc ?? imageSrc);

  return (
    <section aria-label={label} className={cn("media-preview", compact && "media-preview--compact")}>
      <div className="media-preview__heading">
        <span className="text-[0.82rem] text-ink-muted">{label}</span>
        <div className="flex items-center gap-1">
          {actions}
          <Button variant="ghost" size="xs" disabled={!imageSrc && !videoSrc} aria-label={`Preview fit: ${fit === "contain" ? "Fit" : "Fill"}. Change framing`}
            onClick={() => setFit((current) => current === "contain" ? "cover" : "contain")}>
            {fit === "contain" ? "Fit" : "Fill"}
          </Button>
        </div>
      </div>
      <div ref={stage} className="media-preview__stage">
        {failed ? (
          <div className="grid gap-2 px-6 text-center">
            <p className="text-sm text-ink-muted">This preview could not be loaded.</p>
            <Button variant="outline" size="sm" onClick={() => setFailedSource(null)}>Retry preview</Button>
          </div>
        ) : videoSrc ? (
          <video key={videoSrc} controls playsInline preload="metadata" src={videoSrc}
            className="h-full w-full" style={{ objectFit: fit }} aria-label={alt} onError={() => setFailedSource(videoSrc)}
            onLoadedMetadata={event => onVideoDuration?.(event.currentTarget.duration)} />
        ) : imageSrc ? (
          <Image src={imageSrc} alt={alt} fill unoptimized loading="eager" sizes="(max-width: 1023px) 100vw, 70vw"
            style={{ objectFit: fit }} onError={() => setFailedSource(imageSrc)} />
        ) : empty}
      </div>
      <div className="media-preview__transport">
        <span className="t-meta">{caption}</span>
        <div className="flex items-center gap-2">
          {!videoSrc ? (
            <Button variant="secondary" size="icon-sm" className="rounded-full" disabled
              aria-label="Play preview" title="Playback becomes available with a generated clip"><Play size={15} /></Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" disabled={(!imageSrc && !videoSrc) || failed} aria-label="Fullscreen preview"
            onClick={async () => {
              try { await stage.current?.requestFullscreen(); }
              catch { setNotice("Fullscreen is unavailable in this browser."); }
            }}><Maximize2 size={15} /></Button>
        </div>
      </div>
      {notice ? <p role="status" className="t-meta">{notice}</p> : null}
    </section>
  );
}
