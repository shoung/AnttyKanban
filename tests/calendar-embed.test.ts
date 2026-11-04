import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCalendarEmbedUrl } from '../services/calendarEmbed.ts';

const base = 'https://calendar.google.com/calendar/embed';
const valid = `${base}?src=demo%40example.com`;

test('accepts an official single-calendar embed and canonicalizes safely', () => {
  assert.deepEqual(
    validateCalendarEmbedUrl(
      `  HTTPS://CALENDAR.GOOGLE.COM/calendar/embed?showTitle=0&src=demo@example.com&mode=week&ctz=Asia%2FTaipei&bgcolor=%23aabbcc  `,
    ),
    {
      ok: true,
      url: `${base}?bgcolor=%23AABBCC&ctz=Asia%2FTaipei&mode=WEEK&showTitle=0&src=demo%40example.com`,
    },
  );
});

test('accepts synthetic primary, custom-domain, group and holiday calendar identifiers', () => {
  for (const id of [
    'demo@gmail.com',
    'calendar.team@example.org',
    'a'.repeat(64) + '@group.calendar.google.com',
    'en.taiwan#holiday@group.v.calendar.google.com',
    'team+shared@example.com',
  ]) {
    const result = validateCalendarEmbedUrl(`${base}?src=${encodeURIComponent(id)}`);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(new URL(result.url).searchParams.get('src'), id);
  }
});

test('accepts bounded presentation options and emits stable canonical URLs', () => {
  const result = validateCalendarEmbedUrl(
    `${valid}&mode=agenda&ctz=UTC&hl=zh-tw&wkst=2&height=600&color=%2300aaff&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=1&showCalendars=0&showTz=0`,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    const query = new URL(result.url).searchParams;
    assert.equal(query.get('hl'), 'zh-TW');
    assert.equal(query.get('mode'), 'AGENDA');
    assert.equal(query.get('color'), '#00AAFF');
    assert.deepEqual(validateCalendarEmbedUrl(result.url), result);
  }
});

test('rejects non-URL values and HTML without echoing input', () => {
  const expected = validateCalendarEmbedUrl('invalid');
  assert.equal(expected.ok, false);
  for (const input of [
    undefined,
    null,
    {},
    [],
    123,
    '',
    `<iframe src="${valid}"></iframe>`,
    'private-marker',
  ]) {
    assert.deepEqual(validateCalendarEmbedUrl(input), expected);
  }
  assert.equal(JSON.stringify(expected).includes('private-marker'), false);
});

test('rejects origin, credentials, explicit port and encoded-authority bypasses', () => {
  for (const origin of [
    'http://calendar.google.com',
    'https://calendar.google.com.evil.test',
    'https://evil.test@calendar.google.com',
    'https://user:pass@calendar.google.com',
    'https://calendar.google.com@evil.test',
    'https://calendar.google.com:443',
    'https://calendar.google.com:8443',
    'https://%63alendar.google.com',
    'https://calendar.google.com.',
    'https://calendar.google.com%40evil.test',
    '//calendar.google.com',
    'https:\\calendar.google.com',
  ])
    assert.equal(
      validateCalendarEmbedUrl(`${origin}/calendar/embed?src=demo%40example.com`).ok,
      false,
    );
});

test('rejects normalized, encoded and non-embed paths', () => {
  for (const path of [
    '/calendar/EMBED',
    '/calendar/embed/',
    '/calendar/u/0/r',
    '/calendar/ical/demo/private-token/basic.ics',
    '/calendar/../calendar/embed',
    '/calendar/%65mbed',
    '//calendar/embed',
    '/calendar/./embed',
    '/calendar/%2e/embed',
  ]) {
    assert.equal(
      validateCalendarEmbedUrl(`https://calendar.google.com${path}?src=demo%40example.com`).ok,
      false,
    );
  }
});

test('rejects fragments and control characters before URL parsing can normalize them', () => {
  for (const input of [
    `${valid}#`,
    `${valid}#private-marker`,
    valid.replace('google', 'goo\ngle'),
    `${valid}\u0000`,
    `${valid}&ctz=Asia%00Taipei`,
  ]) {
    assert.equal(validateCalendarEmbedUrl(input).ok, false);
  }
});

test('requires exactly one source and rejects duplicate presentation parameters', () => {
  for (const input of [
    base,
    `${base}?`,
    `${base}?mode=MONTH`,
    `${base}?src=`,
    `${valid}&src=other%40example.com`,
    `${valid}&%73rc=other%40example.com`,
    `${valid}&mode=MONTH&mode=WEEK`,
  ]) {
    assert.equal(validateCalendarEmbedUrl(input).ok, false);
  }
});

test('rejects unknown, authentication, redirect and secret iCal parameters', () => {
  for (const key of [
    'authuser',
    'token',
    'access_token',
    'refresh_token',
    'secret',
    'ical',
    'redirect',
    'redirect_uri',
    'next',
    'url',
    'SRC',
    'unknown',
  ]) {
    assert.equal(validateCalendarEmbedUrl(`${valid}&${key}=private-marker`).ok, false);
  }
});

test('rejects malformed or secret-like source values', () => {
  for (const id of [
    'opaque-secret',
    'https://example.com/private/basic.ics',
    'demo@example.com/path',
    'demo@example.com?token=secret',
    'demo@example.com#secret',
    'demo%40example.com',
    'demo@example..com',
    'demo@-example.com',
    'demo@localhost',
    'demo @example.com',
    'demo@example.com\n',
  ]) {
    assert.equal(validateCalendarEmbedUrl(`${base}?src=${encodeURIComponent(id)}`).ok, false);
  }
});

test('bounds source length at 320 decoded characters', () => {
  assert.equal(validateCalendarEmbedUrl(`${base}?src=${'a'.repeat(308)}%40example.com`).ok, true);
  assert.equal(validateCalendarEmbedUrl(`${base}?src=${'a'.repeat(309)}%40example.com`).ok, false);
});

test('rejects unsupported or out-of-range presentation values', () => {
  for (const suffix of [
    'mode=DAY',
    'wkst=0',
    'wkst=8',
    'height=99',
    'height=2001',
    'height=1e3',
    'height=-600',
    'showTitle=true',
    'showNav=2',
    'bgcolor=red',
    'color=%23fff',
    'ctz=Not%2FAZone',
    'ctz=%2B08%3A00',
    'hl=%3Cscript%3E',
    'hl=',
    'mode=',
    'ctz=',
  ]) {
    assert.equal(validateCalendarEmbedUrl(`${valid}&${suffix}`).ok, false);
  }
});

test('rejects malformed encoding and excessive input rather than silently repairing it', () => {
  for (const input of [
    `${valid}&mode=%`,
    `${valid}&mode=%ZZ`,
    `${valid}&mode=%C0%AF`,
    `${valid}&mode=${'A'.repeat(5000)}`,
  ]) {
    assert.equal(validateCalendarEmbedUrl(input).ok, false);
  }
});

test('decodes padded and unpadded base64 calendar IDs into canonical email-shaped sources', () => {
  for (const encoded of ['ZGVtb0BleGFtcGxlLmNvbQ', 'ZGVtb0BleGFtcGxlLmNvbQ==']) {
    assert.deepEqual(validateCalendarEmbedUrl(`${base}?src=${encoded}`), { ok: true, url: valid });
  }
  const id = 'synthetic-team@group.calendar.google.com';
  const encoded = Buffer.from(id).toString('base64').replace(/=+$/, '');
  const result = validateCalendarEmbedUrl(`${base}?src=${encodeURIComponent(encoded)}`);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(new URL(result.url).searchParams.get('src'), id);
});

test('base64 decoding never admits tokens, URLs, nested encodings or invalid calendar IDs', () => {
  for (const decoded of [
    'private-token',
    'https://example.com/private/basic.ics',
    'demo@example.com?token=secret',
    'demo@example.com\n',
    'demo%40example.com',
    'ZGVtb0BleGFtcGxlLmNvbQ',
    `${'a'.repeat(309)}@example.com`,
  ]) {
    const encoded = Buffer.from(decoded).toString('base64');
    assert.equal(validateCalendarEmbedUrl(`${base}?src=${encodeURIComponent(encoded)}`).ok, false);
  }
  for (const encoded of [
    'ZGVtb0BleGFtcGxlLmNvbQ=',
    'ZGVtb0BleGFtcGxlLmNvbQ===',
    'ZGVtb0BleGFtcGxlLmNvbR',
    'ZGVt b0BleGFtcGxlLmNvbQ',
    'ZGVtb0BleGFtcGxlLmNvbQ!',
  ]) {
    assert.equal(validateCalendarEmbedUrl(`${base}?src=${encodeURIComponent(encoded)}`).ok, false);
  }
});

test('bounded plain-text titles are discarded rather than forwarded or stored in the canonical URL', () => {
  for (const title of ['', 'Private calendar title', '示範日曆', 'a'.repeat(256)]) {
    assert.deepEqual(validateCalendarEmbedUrl(`${valid}&title=${encodeURIComponent(title)}`), {
      ok: true,
      url: valid,
    });
  }
});

test('rejects excessive, markup, control-character and duplicate titles', () => {
  for (const title of [
    'a'.repeat(257),
    '<script>private</script>',
    'hello\nworld',
    'hello\u0000world',
  ]) {
    assert.equal(validateCalendarEmbedUrl(`${valid}&title=${encodeURIComponent(title)}`).ok, false);
  }
  assert.equal(validateCalendarEmbedUrl(`${valid}&title=one&title=two`).ok, false);
});
