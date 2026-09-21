import type { CSSProperties } from "react";
import { Globe, Library, Play, Users } from "lucide-react";
import { DEFAULT_VOICE, VOICES } from "@/lib/types";

/** Library rows for the saved-work panel. */
const LIBRARY_ITEMS = [
  { title: "Weekly essay draft", length: "4:38", voice: DEFAULT_VOICE },
  { title: "Interview, part one", length: "11:02", voice: VOICES[0] },
  { title: "Release notes", length: "2:15", voice: VOICES[1] },
  { title: "Reading list, March", length: "6:47", voice: DEFAULT_VOICE },
  { title: "Notes from the coast", length: "3:29", voice: VOICES[5] },
];

/**
 * Reader preview: the Nira stack bento, widened into a showcase of the two
 * surfaces that actually exist — the reader and the library.
 */
export function ReaderPreview() {
  return (
    <section className="lp-section" id="reader">
      <div className="lp-container lp-section-stack">
        <div className="lp-section-header">
          <h2 className="t-section-title lp-section-headline">
            Two surfaces.{" "}
            <span className="lp-headline-muted">
              The page you read,
              <br className="lp-line-break" /> and the shelf it sits on.
            </span>
          </h2>
          <p className="t-card-desc lp-section-subtext">
            Come back to any piece, start it where you left it, and decide who else can hear it.
          </p>
        </div>

        <div className="lp-showcase-grid">
          <article className="lp-showcase-card lp-showcase-reader">
            <h3 className="lp-showcase-title">The reader</h3>
            <div className="lp-showcase-reader-body">
              <p className="lp-showcase-reader-copy">
                Half a mile out, the channel markers lean with the current, and the ferry lines up
                against them one at a time. The crossing takes{" "}
                <span className="reader-word-active">nineteen</span>{" "}
                <span className="lp-reader-copy-dim">
                  minutes in good weather and rather longer in the fog that arrives most afternoons.
                </span>
              </p>
              <div className="lp-inline-player" aria-hidden="true">
                <span className="lp-inline-player-btn">
                  <Play width={12} height={12} strokeWidth={2} />
                </span>
                <span className="lp-player-track">
                  <span
                    className="lp-player-fill"
                    style={{ "--lp-progress": "46%" } as CSSProperties}
                  />
                </span>
                <span className="t-mono lp-player-time">2:07</span>
              </div>
            </div>
            <p className="t-card-desc lp-showcase-text">
              Text leads the audio, so you can read ahead or sit back and follow the marker.
            </p>
          </article>

          <article className="lp-showcase-card lp-showcase-library">
            <div className="lp-library-panel">
              <div className="lp-library-head">
                <Library width={14} height={14} strokeWidth={2} aria-hidden="true" />
                <span>Your library</span>
              </div>
              <div className="lp-library-list">
                {LIBRARY_ITEMS.map((item) => (
                  <div className="lp-library-row" key={item.title}>
                    <span className="lp-library-row-name">{item.title}</span>
                    <span className="lp-library-row-meta">
                      <span className="t-mono">{item.voice}</span>
                      <span className="t-mono">{item.length}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <p className="t-card-desc lp-showcase-text">
              Every finished narration is kept, with the voice it was read in and the text it came
              from.
            </p>
          </article>

          <article className="lp-showcase-card lp-showcase-marker">
            <h3 className="lp-showcase-title">The marker tracks the voice</h3>
            <div className="lp-marker-lines">
              <span>
                and twice a day the flats{" "}
                <span className="reader-word-active">change</span> colour
              </span>
              <span className="lp-reader-copy-dim">by the time the water reaches the seawall</span>
            </div>
            <p className="t-card-desc lp-showcase-text">
              Word timings come back with the audio, so the highlight lands on the word being said.
            </p>
          </article>

          <article className="lp-showcase-card lp-showcase-share">
            <h3 className="lp-showcase-title">Share it, or publish it</h3>
            <div className="lp-share-rows">
              <span className="lp-share-row">
                <Users width={14} height={14} strokeWidth={2} aria-hidden="true" />
                Send it to a few people by email
              </span>
              <span className="lp-share-row">
                <Globe width={14} height={14} strokeWidth={2} aria-hidden="true" />
                Or open it to anyone with the link
              </span>
            </div>
            <p className="t-card-desc lp-showcase-text">
              Everything starts private. You choose when that changes.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}
