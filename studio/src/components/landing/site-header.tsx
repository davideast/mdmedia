import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

/**
 * The Nira frosted sticky pill header. Brand mark on the left, a single
 * sign-in action on the right.
 */
export function SiteHeader() {
  return (
    <header className="lp-site-header">
      <div className="lp-nav-wrapper">
        <div className="lp-nav-pill">
          <Link href="/" className="lp-brand" aria-label="mdmedia studio, home">
            <BrandMark />
          </Link>
          <Link href="/studio" className="lp-btn lp-btn-primary lp-btn-header">
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}
