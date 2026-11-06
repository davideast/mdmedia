const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM_HEAD = /(?=\*\*|\[?(?:\d{1,2}:)?\d{1,2}:[0-5]\d|[A-Z])/;
const LEADING_BULLET = new RegExp(`^\\s*[-*]\\s+${ITEM_HEAD.source}`);
const INLINE_BULLET = new RegExp(`([:.!?;])[ \\t]+([-*])[ \\t]+${ITEM_HEAD.source}`, 'g');
const COLON_BULLET = new RegExp(`(:)[ \\t]+([-*])[ \\t]+${ITEM_HEAD.source}`);
const INLINE_ORDERED = new RegExp(`([.!?;])[ \\t]+(\\d+[.)])[ \\t]+${ITEM_HEAD.source}`, 'g');

/**
 * Repairs single-line list and heading runs that models occasionally emit
 * (e.g. `moments: - 00:00: Intro. - 00:02: Cut.`) without touching fenced code
 * blocks, inline code spans, or ordinary hyphenated prose.
 */
export function normalizeAnalysisMarkdown(markdown: string): string {
  if (!markdown) return '';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let fence = '';
  return lines.map(line => {
    const open = FENCE.exec(line)?.[1];
    if (open) {
      if (!fence) fence = open[0]!.repeat(open.length);
      else if (line.trimStart().startsWith(fence) && new RegExp(`^\\s*${fence[0]}+\\s*$`).test(line)) fence = '';
      return line;
    }
    if (fence) return line;
    const codes: string[] = [];
    let masked = line.replace(/`[^`]+`/g, span => `\u0000${codes.push(span) - 1}\u0000`);
    masked = masked.replace(/([.!?])[ \t]+(#{1,6}[ \t]+\S)/g, '$1\n\n$2');
    const inlineBullets = [...masked.matchAll(INLINE_BULLET)].length;
    const bulletTotal = (LEADING_BULLET.test(masked) ? 1 : 0) + inlineBullets;
    if (bulletTotal >= 2 || /:[ \t]+[-*][ \t]+(?:\*\*|\[?(?:\d{1,2}:)?\d{1,2}:[0-5]\d)/.test(masked)) {
      if (!LEADING_BULLET.test(masked)) masked = masked.replace(COLON_BULLET, '$1\n\n$2 ');
      masked = masked.replace(INLINE_BULLET, '$1\n$2 ');
    }
    if (/(?:^|[:.!?;][ \t]+)1([.)])[ \t]+/.test(masked) && /[.!?;][ \t]+2[.)][ \t]+/.test(masked)) {
      if (!/^\s*1[.)][ \t]+/.test(masked)) masked = masked.replace(/(:)[ \t]+(1[.)])[ \t]+/, '$1\n\n$2 ');
      masked = masked.replace(INLINE_ORDERED, '$1\n$2 ');
    }
    return masked.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)] ?? '');
  }).join('\n');
}
