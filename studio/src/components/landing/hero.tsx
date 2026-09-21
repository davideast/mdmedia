import type { CSSProperties } from "react";
import Link from "next/link";
import { FileText, Play, SkipBack } from "lucide-react";
import { DEFAULT_VOICE } from "@/lib/types";

/** Bar heights for the static equalizer in the specimen card, in pixels. */
const EQUALIZER_BARS = [8, 16, 11, 22, 14, 19, 9];

/**
 * Hero: the Nira hero layout — headline, one supporting sentence, actions —
 * followed by the Nira specimen panel, here drawn as the actual reader: a
 * paragraph with the current narration position marked, and a player beneath.
 */
export function Hero() {
  return (
    <section className="lp-hero" id="top">
      <div className="lp-container lp-hero-container">
        <div className="lp-hero-content">
          <h1 className="t-display lp-hero-headline">
            Writing you can listen to,
            <br className="lp-line-break" />{" "}
            <span className="lp-headline-muted">and follow word by word.</span>
          </h1>
          <p className="t-lead lp-hero-subcopy">
            Paste in your text, pick a voice, and the narration starts speaking right away — the
            audio streams back while the words appear on screen, with a marker sitting on the word
            being spoken.
          </p>
          <div className="lp-hero-actions">
            <Link href="/studio" className="lp-btn lp-btn-primary">
              Start narrating
            </Link>
            <Link href="#how-it-works" className="lp-btn lp-btn-quiet">
              See how it works
            </Link>
          </div>
        </div>

        <div
          className="lp-specimen-card"
          role="img"
          aria-label="The reader with a narration playing: a paragraph of text with the word being spoken marked, and a player bar below it."
        >
          <div className="lp-specimen-head">
            <span className="lp-specimen-head-icon">
              <FileText width={17} height={17} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="lp-specimen-title">Weekly essay draft</span>
            <span className="t-mono">{DEFAULT_VOICE}</span>
          </div>

          <div className="lp-specimen-body">
            <div className="lp-specimen-read">
              <span className="t-eyebrow">Reading</span>
              <p className="lp-reader-copy">
                The tide comes in twice a day, and twice a day the flats change colour. By the time
                the water reaches the seawall the birds have moved inland, feeding in the shallow{" "}
                <span className="reader-word-active">channels</span>{" "}
                <span className="lp-reader-copy-dim">
                  left behind by the morning. Nothing about the pattern is hurried.
                </span>
              </p>
            </div>

            <div className="lp-specimen-side">
              <div className="lp-side-card">
                <span className="t-label">Voice</span>
                <span className="lp-side-value">{DEFAULT_VOICE}</span>
                <span className="lp-equalizer">
                  {EQUALIZER_BARS.map((height, index) => (
                    <span key={index} style={{ blockSize: height }} />
                  ))}
                </span>
              </div>
              <div className="lp-side-card">
                <span className="t-label">Length</span>
                <span className="lp-side-value">4:38</span>
                <span className="t-meta">Kept in your library</span>
              </div>
            </div>
          </div>

          <div className="lp-player">
            <span className="lp-player-step">
              <SkipBack width={16} height={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="lp-player-btn">
              <Play width={15} height={15} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="t-mono lp-player-time">1:47</span>
            <span className="lp-player-track">
              <span
                className="lp-player-fill"
                style={{ "--lp-progress": "38%" } as CSSProperties}
              />

            </span>
            <span className="t-mono lp-player-time">4:38</span>
          </div>
        </div>
      </div>
    </section>
  );
}
