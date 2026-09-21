import { AudioLines, BookOpen, Check, Library } from "lucide-react";

/**
 * Feature triad: the Nira three-column layout with hairline separators and a
 * specimen mock above each numbered meta block.
 */
export function FeatureTriad() {
  return (
    <section className="lp-section" id="features">
      <div className="lp-container lp-section-stack">
        <div className="lp-section-header">
          <h2 className="t-section-title lp-section-headline">
            From pasted text
            <br className="lp-line-break" /> <span className="lp-headline-muted">to a voice
            reading it.</span>
          </h2>
          <p className="t-card-desc lp-section-subtext">
            No render queue, no waiting for a file, no download before you can hear anything.
          </p>
        </div>

        <div className="lp-triad-grid">
          <article className="lp-triad-item">
            <div className="lp-specimen-box">
              <span className="lp-chip">
                <AudioLines
                  className="lp-chip-icon"
                  width={13}
                  height={13}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span>Speaking now</span>
              </span>
              <span className="lp-chip lp-chip-split">
                <span className="lp-chip-lead">
                  <span>Paragraph two</span>
                </span>
                <span className="t-mono">0:18</span>
              </span>
            </div>
            <div className="lp-feature-meta">
              <span className="t-eyebrow">01</span>
              <h3 className="lp-feature-title">Starts speaking immediately</h3>
              <p className="t-card-desc lp-feature-desc">
                Audio streams back as it is made, so the first line plays while the rest is still
                being written.
              </p>
            </div>
          </article>

          <article className="lp-triad-item">
            <div className="lp-specimen-box lp-specimen-box-subtle">
              <span className="lp-chip">
                <BookOpen
                  className="lp-chip-icon"
                  width={13}
                  height={13}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span>
                  A marker sits on{" "}
                  <span className="reader-word-active">this</span> word
                </span>
              </span>
              <span className="lp-chip lp-chip-split">
                <span className="lp-chip-lead">
                  <span>Scroll follows the voice</span>
                </span>
                <Check
                  className="lp-chip-icon"
                  width={12}
                  height={12}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            </div>
            <div className="lp-feature-meta">
              <span className="t-eyebrow">02</span>
              <h3 className="lp-feature-title">Read along as it speaks</h3>
              <p className="t-card-desc lp-feature-desc">
                Each word is timed against the audio, so you always see where the narration is.
              </p>
            </div>
          </article>

          <article className="lp-triad-item">
            <div className="lp-specimen-box lp-specimen-box-accent">
              <span className="lp-chip lp-chip-split">
                <span className="lp-chip-lead">
                  <Library
                    className="lp-chip-icon"
                    width={12}
                    height={12}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span>Weekly essay draft</span>
                </span>
                <span className="t-mono">4:38</span>
              </span>
              <span className="lp-chip lp-chip-split">
                <span className="lp-chip-lead">
                  <Library
                    className="lp-chip-icon"
                    width={12}
                    height={12}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span>Interview, part one</span>
                </span>
                <span className="t-mono">11:02</span>
              </span>
            </div>
            <div className="lp-feature-meta">
              <span className="t-eyebrow">03</span>
              <h3 className="lp-feature-title">Keeps everything you make</h3>
              <p className="t-card-desc lp-feature-desc">
                Finished pieces stay in your library to read again, share, or publish.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
