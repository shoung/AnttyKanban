export type CalendarEmbedValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const EMBED_BASE = 'https://calendar.google.com/calendar/embed';
const INVALID_EMBED_MESSAGE = '請貼上有效的 Google 日曆官方嵌入網址（僅限一個日曆）。';
const DISPLAY_SWITCHES = new Set([
  'showTitle',
  'showNav',
  'showDate',
  'showPrint',
  'showTabs',
  'showCalendars',
  'showTz',
]);
const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

/**
 * Validate a user-pasted URL, never HTML. No network requests or permission changes.
 * Only the returned canonical URL may be used as an iframe source.
 * Google embed documentation: https://support.google.com/calendar/answer/41207
 */
export function validateCalendarEmbedUrl(input: unknown): CalendarEmbedValidationResult {
  const invalid = (): CalendarEmbedValidationResult => ({
    ok: false,
    error: INVALID_EMBED_MESSAGE,
  });
  if (typeof input !== 'string' || input.length > 4096 || hasControlCharacters(input))
    return invalid();

  try {
    const value = input.trim();
    // Inspect the raw authority/path before URL parsing can normalize ports,
    // encoded hosts, dot segments, backslashes or embedded whitespace.
    const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)\?([^#]*)$/i.exec(value);
    if (!raw || raw[1].toLowerCase() !== 'calendar.google.com' || raw[2] !== '/calendar/embed')
      return invalid();
    // URLSearchParams otherwise silently replaces malformed percent encoding.
    decodeURIComponent(raw[3].replace(/\+/g, ' '));
    const parsed = new URL(value);
    if (
      parsed.origin !== 'https://calendar.google.com' ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      return invalid();

    const output = new URL(EMBED_BASE);
    const seen = new Set<string>();
    for (const [key, original] of parsed.searchParams) {
      if (seen.has(key) || hasControlCharacters(original)) return invalid();
      seen.add(key);
      let normalized = original;

      if (key === 'src') {
        // Google may provide base64 IDs. Decode once, then apply exactly the
        // same ID validation and emit only the decoded canonical identifier.
        if (!original.includes('@')) {
          if (original.length > 428 || !/^[A-Za-z0-9+/]+={0,2}$/.test(original)) return invalid();
          normalized = atob(original);
          const encoded = btoa(normalized);
          if (original !== encoded && original !== encoded.replace(/=+$/, '')) return invalid();
        }
        // Email-shaped IDs cover primary/custom-domain, group and holiday
        // calendars. Do not accept URLs, opaque tokens or double encoding.
        if (
          normalized.length > 320 ||
          !/^[A-Za-z0-9.!#$&'*+?^_`{|}~=-]+@[A-Za-z0-9.-]+$/.test(normalized)
        )
          return invalid();
        const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
        if (
          !domain.includes('.') ||
          domain.length > 253 ||
          !domain
            .split('.')
            .every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
        )
          return invalid();
      } else if (key === 'title') {
        // Official embed URLs can include a display title. Validate then drop
        // it so personal free text never reaches the persisted/iframe URL.
        if (original.length > 256 || /[<>]/.test(original)) return invalid();
        continue;
      } else if (DISPLAY_SWITCHES.has(key)) {
        if (original !== '0' && original !== '1') return invalid();
      } else if (key === 'mode') {
        normalized = original.toUpperCase();
        if (!['MONTH', 'WEEK', 'AGENDA'].includes(normalized)) return invalid();
      } else if (key === 'wkst') {
        if (!/^[1-7]$/.test(original)) return invalid();
      } else if (key === 'height') {
        if (!/^\d{3,4}$/.test(original) || Number(original) < 100 || Number(original) > 2000)
          return invalid();
        normalized = String(Number(original));
      } else if (key === 'bgcolor' || key === 'color') {
        if (!/^#[0-9a-f]{6}$/i.test(original)) return invalid();
        normalized = original.toUpperCase();
      } else if (key === 'ctz') {
        if (original.length > 80 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(original))
          return invalid();
        normalized = new Intl.DateTimeFormat('en', { timeZone: original }).resolvedOptions()
          .timeZone;
      } else if (key === 'hl') {
        if (original.length > 35 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(original))
          return invalid();
        normalized = Intl.getCanonicalLocales(original)[0];
      } else {
        // Includes auth selectors, tokens, redirects and iCal links.
        return invalid();
      }
      output.searchParams.set(key, normalized);
    }
    if (!seen.has('src')) return invalid();
    output.searchParams.sort();
    return { ok: true, url: output.href };
  } catch {
    // Never include user input, calendar identifiers or parser diagnostics.
    return invalid();
  }
}
