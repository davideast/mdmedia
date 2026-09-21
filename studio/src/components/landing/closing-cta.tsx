import Link from "next/link";

/** Closing CTA: the Nira enclosure card, ported. */
export function ClosingCta() {
  return (
    <section className="lp-section" id="get-started">
      <div className="lp-container">
        <div className="lp-cta-card">
          <div className="lp-cta-copy">
            <h2 className="t-display lp-cta-headline">
              Hear your own writing
              <br className="lp-line-break" />{" "}
              <span className="lp-headline-muted">in the next minute.</span>
            </h2>
            <p className="t-lead lp-cta-subcopy">
              Paste a paragraph, choose a voice, and listen while the rest of it is still being
              read.
            </p>
          </div>
          <div className="lp-cta-actions">
            <Link href="/studio" className="lp-btn lp-btn-primary">
              Start narrating
            </Link>
            <p className="t-meta">Your narrations stay private until you share them.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
