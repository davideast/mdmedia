import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

/**
 * Footer: the Nira footer grid, with its four link columns reduced to the two
 * that have somewhere real to point.
 */
export function SiteFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-grid">
        <div className="lp-footer-brand">
          <Link href="/" className="lp-brand" aria-label="mdmedia studio, home">
            <BrandMark />
          </Link>
          <p className="t-meta lp-footer-tagline">
            Writing turned into narration you can follow word by word, kept in a library you come
            back to.
          </p>
        </div>

        <nav className="lp-footer-nav" aria-label="Footer">
          <div className="lp-footer-col">
            <span className="t-eyebrow">Product</span>
            <ul className="lp-footer-links">
              <li>
                <Link href="/studio">Studio</Link>
              </li>
              <li>
                <Link href="#reader">Reader</Link>
              </li>
              <li>
                <Link href="#features">What it does</Link>
              </li>
            </ul>
          </div>
          <div className="lp-footer-col">
            <span className="t-eyebrow">Get started</span>
            <ul className="lp-footer-links">
              <li>
                <Link href="#how-it-works">How it works</Link>
              </li>
              <li>
                <Link href="/studio">Sign in</Link>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </footer>
  );
}
