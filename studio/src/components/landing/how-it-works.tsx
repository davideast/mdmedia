import type { CSSProperties } from "react";
import { Check, Play } from "lucide-react";
import { DEFAULT_VOICE, VOICES } from "@/lib/types";

/** Three real voices, the default first, for the picker mock in step two. */
const PICKER_VOICES = [DEFAULT_VOICE, VOICES[0], VOICES[1]];

/** Widths of the pasted-text lines in step one. */
const PASTED_LINES = ["100%", "92%", "76%", "88%", "54%"];

/**
 * How it works: the Nira matrix canvas card, re-cut as three numbered steps.
 * The rail/tab interaction is dropped — there is nothing here to switch, so
 * the card keeps its chrome and hairline columns and stays a server component.
 */
export function HowItWorks() {
  return (
    <section className="lp-section" id="how-it-works">
      <div className="lp-container lp-section-stack">
        <div className="lp-section-header">
          <h2 className="t-section-title lp-section-headline">
            Three steps.{" "}
            <span className="lp-headline-muted">
              Under a minute
              <br className="lp-line-break" /> to the first sentence.
            </span>
          </h2>
          <p className="t-card-desc lp-section-subtext">
            The same three steps every time, whether it is a paragraph or a long piece.
          </p>
        </div>

        <div className="lp-steps-card">
          <article className="lp-step">
            <div className="lp-step-visual" aria-hidden="true">
              {PASTED_LINES.map((width, index) => (
                <span
                  key={width + index}
                  className={index === 0 ? "lp-text-line lp-text-line-strong" : "lp-text-line"}
                  style={{ inlineSize: width }}
                />
              ))}
            </div>
            <div className="lp-step-head">
              <span className="t-eyebrow">Step 01</span>
              <h3 className="lp-step-title">Paste your text</h3>
              <p className="t-card-desc lp-step-desc">
                Drop in a draft, a post, or a set of notes. Markdown is read the way it is written.
              </p>
            </div>
          </article>

          <article className="lp-step">
            <div className="lp-step-visual" aria-hidden="true">
              {PICKER_VOICES.map((voice, index) => (
                <span
                  key={voice}
                  className={index === 0 ? "lp-voice-row lp-voice-row-selected" : "lp-voice-row"}
                >
                  <span>{voice}</span>
                  {index === 0 ? <Check width={12} height={12} strokeWidth={2} /> : null}
                </span>
              ))}
            </div>
            <div className="lp-step-head">
              <span className="t-eyebrow">Step 02</span>
              <h3 className="lp-step-title">Pick a voice</h3>
              <p className="t-card-desc lp-step-desc">
                Thirty voices to choose from, and a line of direction if you want a particular
                delivery.
              </p>
            </div>
          </article>

          <article className="lp-step">
            <div className="lp-step-visual" aria-hidden="true">
              <span className="lp-step-player">
                <span className="lp-inline-player-btn">
                  <Play width={12} height={12} strokeWidth={2} />
                </span>
                <span className="lp-player-track">
                  <span
                    className="lp-player-fill"
                    style={{ "--lp-progress": "62%" } as CSSProperties}
                  />
                </span>
                <span className="t-mono lp-player-time">2:54</span>
              </span>
              <span className="lp-text-line lp-text-line-strong" style={{ inlineSize: "84%" }} />
              <span className="lp-text-line" style={{ inlineSize: "96%" }} />
              <span className="lp-text-line" style={{ inlineSize: "62%" }} />
            </div>
            <div className="lp-step-head">
              <span className="t-eyebrow">Step 03</span>
              <h3 className="lp-step-title">Listen and follow</h3>
              <p className="t-card-desc lp-step-desc">
                It starts speaking while the rest is still being made, and the marker keeps your
                place.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
