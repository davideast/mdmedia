/**
 * A time in a video as seconds: `90`, `90s`, `12.5`, `20m`, `1h`, `01:15` (MM:SS), or `1:02:03` (HH:MM:SS).
 * Returns undefined for undefined; throws a one-line error naming `flag` otherwise.
 */
export function parseVideoTime(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  const unit = /^(\d+(?:\.\d+)?)(s|m|h)?$/i.exec(text);
  if (unit) return Number(unit[1]) * ({ s: 1, m: 60, h: 3600 }[(unit[2] ?? 's').toLowerCase() as 's' | 'm' | 'h']);
  const clock = /^(?:(\d+):)?([0-5]?\d):([0-5]\d(?:\.\d+)?)$/.exec(text);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  throw new Error(`${flag} must be seconds (90, 90s), minutes (20m), or a timestamp (MM:SS or HH:MM:SS) (got "${value}").`);
}
