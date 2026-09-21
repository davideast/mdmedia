import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/site-header";
import { Hero } from "@/components/landing/hero";
import { FeatureTriad } from "@/components/landing/feature-triad";
import { HowItWorks } from "@/components/landing/how-it-works";
import { ReaderPreview } from "@/components/landing/reader-preview";
import { ClosingCta } from "@/components/landing/closing-cta";
import { SiteFooter } from "@/components/landing/site-footer";
import "./landing.css";

export const metadata: Metadata = {
  title: "mdmedia studio — writing you can listen to",
  description:
    "Paste in your text, pick a voice, and the narration starts speaking right away, with a marker on the word being read.",
};

export default function LandingPage() {
  return (
    <div className="lp-page">
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <FeatureTriad />
        <HowItWorks />
        <ReaderPreview />
        <ClosingCta />
      </main>
      <SiteFooter />
    </div>
  );
}
