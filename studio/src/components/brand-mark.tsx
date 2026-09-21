/**
 * The mdmedia studio wordmark: a waveform glyph plus the product name, always
 * lowercase.
 *
 * Self-contained on purpose — it is used by the landing page and by the app
 * shell, so it carries its own layout and inherits its font size from the
 * caller rather than depending on any one stylesheet.
 */
export function BrandMark({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.55rem",
        fontFamily: "var(--font-display)",
        fontWeight: 600,
        letterSpacing: "-0.015em",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        textTransform: "lowercase",
        minInlineSize: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
        focusable="false"
        style={{ flexShrink: 0 }}
      >
        <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.5" strokeWidth="1.5" />
        <rect x="7" y="9.5" width="2" height="5" rx="1" fill="currentColor" stroke="none" />
        <rect x="11" y="6.5" width="2" height="11" rx="1" fill="currentColor" stroke="none" />
        <rect x="15" y="8.5" width="2" height="7" rx="1" fill="currentColor" stroke="none" />
      </svg>
      <span>
        mdmedia{" "}
        <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>studio</span>
      </span>
    </span>
  );
}
