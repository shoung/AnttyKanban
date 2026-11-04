import { createOAuthSecrets, hashValue, type TokenCipher } from './security.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';
export type ConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'reconnect_required'
  | 'revocation_pending';
export class CalendarError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = 'CalendarError';
    this.code = code;
    this.status = status;
  }
}
export interface CalendarConnection {
  revision: number;
  status: ConnectionStatus;
  googleSubject?: string;
  encryptedRefreshToken?: string;
  grantedScopes?: string[];
  updatedAt: number;
}
export interface OAuthAttempt {
  uid: string;
  bindingHash: string;
  encryptedVerifier: string;
  expectedRevision: number;
  expiresAt: number;
}
export interface CalendarStore {
  getConnection(uid: string): Promise<CalendarConnection | null>;
  saveConnection(
    uid: string,
    connection: CalendarConnection,
    expectedRevision: number,
  ): Promise<boolean>;
  createAttempt(key: string, attempt: OAuthAttempt): Promise<void>;
  /** Must validate AND consume in one transaction; invalid callers must not consume another browser's state. */
  consumeAttempt(key: string, bindingHash: string, now: number): Promise<OAuthAttempt | null>;
}
export interface GoogleGateway {
  authorizationUrl(input: { state: string; challenge: string }): string;
  exchangeCode(
    code: string,
    verifier: string,
  ): Promise<{ subject: string; refreshToken?: string; grantedScopes: string[] }>;
  refreshAccessToken(refreshToken: string): Promise<string>;
  revokeToken(refreshToken: string): Promise<void>;
  request(
    token: string,
    path: string,
    method: string,
    body?: unknown,
    etag?: string,
  ): Promise<unknown>;
}
export interface CalendarDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: CalendarDate;
  end: CalendarDate;
}
export interface CalendarEvent extends CalendarEventInput {
  id: string;
  etag?: string;
  htmlLink?: string;
  readOnly: boolean;
}
export interface CalendarListInput {
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
}
export interface CalendarStatus {
  configured: boolean;
  status: ConnectionStatus | 'not_configured';
  calendar: 'primary';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CalendarError('INVALID_EVENT');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new CalendarError('INVALID_EVENT');
}
function textField(value: unknown, limit: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()))
    throw new CalendarError('INVALID_EVENT');
  return value.trim();
}
function parseDate(value: unknown): { value: CalendarDate; timestamp: number; allDay: boolean } {
  const input = record(value);
  onlyKeys(input, ['date', 'dateTime', 'timeZone']);
  if (typeof input.date === 'string' && input.dateTime === undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new CalendarError('INVALID_EVENT');
    const timestamp = Date.parse(`${input.date}T00:00:00Z`);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== input.date ||
      input.timeZone !== undefined
    )
      throw new CalendarError('INVALID_EVENT');
    return { value: { date: input.date }, timestamp, allDay: true };
  }
  if (
    input.date !== undefined ||
    typeof input.dateTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.dateTime,
    )
  )
    throw new CalendarError('INVALID_EVENT');
  const timestamp = Date.parse(input.dateTime);
  if (!Number.isFinite(timestamp)) throw new CalendarError('INVALID_EVENT');
  const datePart = input.dateTime.slice(0, 10);
  if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart)
    throw new CalendarError('INVALID_EVENT');
  const output: CalendarDate = { dateTime: input.dateTime };
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== 'string' || input.timeZone.length > 100)
      throw new CalendarError('INVALID_EVENT');
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw new CalendarError('INVALID_EVENT');
    }
    output.timeZone = input.timeZone;
  }
  return { value: output, timestamp, allDay: false };
}
export function validateEvent(value: unknown): CalendarEventInput {
  const input = record(value);
  onlyKeys(input, ['summary', 'description', 'location', 'start', 'end']);
  const start = parseDate(input.start);
  const end = parseDate(input.end);
  if (start.allDay !== end.allDay || end.timestamp <= start.timestamp)
    throw new CalendarError('INVALID_EVENT');
  const result: CalendarEventInput = {
    summary: textField(input.summary, 500, true)!,
    start: start.value,
    end: end.value,
  };
  const description = textField(input.description, 8000);
  const location = textField(input.location, 1000);
  if (description !== undefined) result.description = description;
  if (location !== undefined) result.location = location;
  return result;
}
function eventId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value))
    throw new CalendarError('INVALID_EVENT_ID');
  return encodeURIComponent(value);
}
function isPersonalEvent(event: Record<string, unknown>): boolean {
  const organizer = event.organizer as { self?: boolean } | undefined;
  return (
    !event.attendeesOmitted &&
    (!Array.isArray(event.attendees) || event.attendees.length === 0) &&
    organizer?.self !== false &&
    !event.recurrence &&
    !event.recurringEventId &&
    (!event.eventType || event.eventType === 'default')
  );
}
function publicEvent(value: unknown): CalendarEvent {
  const data = record(value);
  return {
    id: String(data.id ?? ''),
    summary: String(data.summary ?? '(未命名活動)'),
    description: typeof data.description === 'string' ? data.description : undefined,
    location: typeof data.location === 'string' ? data.location : undefined,
    start: data.start as CalendarDate,
    end: data.end as CalendarDate,
    etag: typeof data.etag === 'string' ? data.etag : undefined,
    htmlLink:
      typeof data.htmlLink === 'string' &&
      data.htmlLink.startsWith('https://www.google.com/calendar/')
        ? data.htmlLink
        : undefined,
    readOnly: !isPersonalEvent(data),
  };
}

export class CalendarService {
  private deps: {
    store: CalendarStore;
    google: GoogleGateway;
    cipher: TokenCipher;
    expectedGoogleSubject: (uid: string) => Promise<string>;
    now: () => number;
  };
  constructor(deps: {
    store: CalendarStore;
    google: GoogleGateway;
    cipher: TokenCipher;
    expectedGoogleSubject: (uid: string) => Promise<string>;
    now?: () => number;
  }) {
    this.deps = { ...deps, now: deps.now ?? Date.now };
  }
  async getStatus(uid: string): Promise<CalendarStatus> {
    const connection = await this.deps.store.getConnection(uid);
    return { configured: true, status: connection?.status ?? 'disconnected', calendar: 'primary' };
  }
  async beginConnect(uid: string, browserBinding: string): Promise<{ authorizationUrl: string }> {
    if (!browserBinding || browserBinding.length > 512)
      throw new CalendarError('OAUTH_STATE_INVALID');
    await this.deps.expectedGoogleSubject(uid);
    const existing = await this.deps.store.getConnection(uid);
    if (existing?.status === 'revocation_pending')
      throw new CalendarError('REVOCATION_PENDING', 409);
    const secrets = createOAuthSecrets();
    await this.deps.store.createAttempt(hashValue(secrets.state), {
      uid,
      bindingHash: hashValue(browserBinding),
      expectedRevision: existing?.revision ?? 0,
      encryptedVerifier: this.deps.cipher.seal(secrets.verifier, uid),
      expiresAt: this.deps.now() + 600_000,
    });
    return {
      authorizationUrl: this.deps.google.authorizationUrl({
        state: secrets.state,
        challenge: secrets.challenge,
      }),
    };
  }
  async completeConnect(state: string, browserBinding: string, code: string): Promise<void> {
    if (
      !/^[A-Za-z0-9_-]{43,128}$/.test(state) ||
      !browserBinding ||
      typeof code !== 'string' ||
      !code ||
      code.length > 4096
    )
      throw new CalendarError('OAUTH_STATE_INVALID');
    const attempt = await this.deps.store.consumeAttempt(
      hashValue(state),
      hashValue(browserBinding),
      this.deps.now(),
    );
    if (!attempt) throw new CalendarError('OAUTH_STATE_INVALID');
    const expectedSubject = await this.deps.expectedGoogleSubject(attempt.uid);
    const existing = await this.deps.store.getConnection(attempt.uid);
    if (
      (existing?.revision ?? 0) !== attempt.expectedRevision ||
      existing?.status === 'revocation_pending'
    )
      throw new CalendarError('CONNECTION_CHANGED', 409);
    const tokens = await this.deps.google.exchangeCode(
      code,
      this.deps.cipher.open(attempt.encryptedVerifier, attempt.uid),
    );
    if (tokens.subject !== expectedSubject) throw new CalendarError('GOOGLE_ACCOUNT_MISMATCH');
    if (!tokens.grantedScopes.includes(CALENDAR_SCOPE))
      throw new CalendarError('CALENDAR_SCOPE_REQUIRED');
    const encryptedRefreshToken = tokens.refreshToken
      ? this.deps.cipher.seal(tokens.refreshToken, attempt.uid)
      : existing?.googleSubject === expectedSubject && existing.status === 'connected'
        ? existing.encryptedRefreshToken
        : undefined;
    if (!encryptedRefreshToken) throw new CalendarError('OFFLINE_ACCESS_REQUIRED');
    const saved = await this.deps.store.saveConnection(
      attempt.uid,
      {
        revision: attempt.expectedRevision + 1,
        status: 'connected',
        googleSubject: expectedSubject,
        encryptedRefreshToken,
        grantedScopes: tokens.grantedScopes,
        updatedAt: this.deps.now(),
      },
      attempt.expectedRevision,
    );
    if (!saved) throw new CalendarError('CONNECTION_CHANGED', 409);
  }
  async disconnect(
    uid: string,
    confirmProjectRevocation: boolean,
  ): Promise<{ status: ConnectionStatus }> {
    if (confirmProjectRevocation !== true)
      throw new CalendarError('REVOCATION_CONFIRMATION_REQUIRED');
    const existing = await this.deps.store.getConnection(uid);
    const revision = existing?.revision ?? 0;
    if (!existing?.encryptedRefreshToken) {
      if (
        !(await this.deps.store.saveConnection(
          uid,
          { revision: revision + 1, status: 'disconnected', updatedAt: this.deps.now() },
          revision,
        ))
      )
        throw new CalendarError('CONNECTION_CHANGED', 409);
      return { status: 'disconnected' };
    }
    const pending: CalendarConnection = {
      ...existing,
      status: 'revocation_pending',
      revision: revision + 1,
      updatedAt: this.deps.now(),
    };
    if (!(await this.deps.store.saveConnection(uid, pending, revision)))
      throw new CalendarError('CONNECTION_CHANGED', 409);
    try {
      await this.deps.google.revokeToken(
        this.deps.cipher.open(existing.encryptedRefreshToken, uid),
      );
    } catch {
      // Never resume Calendar calls after a disconnect intent, even if Google is unavailable.
      return { status: 'revocation_pending' };
    }
    if (
      !(await this.deps.store.saveConnection(
        uid,
        { revision: revision + 2, status: 'disconnected', updatedAt: this.deps.now() },
        revision + 1,
      ))
    )
      throw new CalendarError('CONNECTION_CHANGED', 409);
    return { status: 'disconnected' };
  }
  private async assertCurrentConnection(uid: string, revision: number): Promise<void> {
    const current = await this.deps.store.getConnection(uid);
    if (current?.status !== 'connected' || current.revision !== revision)
      throw new CalendarError('CONNECTION_CHANGED', 409);
  }
  private async accessToken(uid: string): Promise<{ token: string; revision: number }> {
    const connection = await this.deps.store.getConnection(uid);
    if (connection?.status !== 'connected' || !connection.encryptedRefreshToken)
      throw new CalendarError('CALENDAR_NOT_CONNECTED', 409);
    let token: string;
    try {
      token = await this.deps.google.refreshAccessToken(
        this.deps.cipher.open(connection.encryptedRefreshToken, uid),
      );
    } catch (error) {
      if (error instanceof CalendarError && error.code === 'RECONNECT_REQUIRED') {
        await this.deps.store.saveConnection(
          uid,
          {
            ...connection,
            status: 'reconnect_required',
            revision: connection.revision + 1,
            updatedAt: this.deps.now(),
          },
          connection.revision,
        );
      }
      throw error;
    }
    await this.assertCurrentConnection(uid, connection.revision);
    return { token, revision: connection.revision };
  }
  async listEvents(
    uid: string,
    input: CalendarListInput = {},
  ): Promise<{
    events: CalendarEvent[];
    timeMin: string;
    timeMax: string;
    nextPageToken?: string;
  }> {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some((key) => !['timeMin', 'timeMax', 'pageToken'].includes(key))
    )
      throw new CalendarError('INVALID_RANGE');
    const min = input.timeMin ? Date.parse(input.timeMin) : this.deps.now() - 30 * 86_400_000;
    const max = input.timeMax ? Date.parse(input.timeMax) : this.deps.now() + 90 * 86_400_000;
    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      max <= min ||
      max - min > 366 * 86_400_000 ||
      (input.pageToken !== undefined &&
        (typeof input.pageToken !== 'string' || input.pageToken.length > 2048))
    )
      throw new CalendarError('INVALID_RANGE');
    const query = new URLSearchParams({
      timeMin: new Date(min).toISOString(),
      timeMax: new Date(max).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '100',
    });
    if (input.pageToken) {
      if (!input.timeMin || !input.timeMax) throw new CalendarError('INVALID_RANGE');
      query.set('pageToken', input.pageToken);
    }
    const grant = await this.accessToken(uid);
    const response = record(
      await this.deps.google.request(grant.token, `/calendars/primary/events?${query}`, 'GET'),
    );
    return {
      timeMin: new Date(min).toISOString(),
      timeMax: new Date(max).toISOString(),
      events: Array.isArray(response.items) ? response.items.map(publicEvent) : [],
      ...(typeof response.nextPageToken === 'string'
        ? { nextPageToken: response.nextPageToken }
        : {}),
    };
  }
  async createEvent(uid: string, input: unknown): Promise<CalendarEvent> {
    const event = validateEvent(input);
    const grant = await this.accessToken(uid);
    return publicEvent(
      await this.deps.google.request(
        grant.token,
        '/calendars/primary/events?sendUpdates=none',
        'POST',
        event,
      ),
    );
  }
  private async editableEvent(
    token: string,
    id: string,
    etag?: string,
  ): Promise<string | undefined> {
    const event = record(
      await this.deps.google.request(token, `/calendars/primary/events/${id}`, 'GET'),
    );
    if (!isPersonalEvent(event)) throw new CalendarError('PERSONAL_EVENTS_ONLY', 403);
    if (
      etag !== undefined &&
      (typeof etag !== 'string' || etag.length > 256 || etag !== event.etag)
    )
      throw new CalendarError('EVENT_CHANGED', 409);
    return typeof event.etag === 'string' ? event.etag : undefined;
  }
  async updateEvent(
    uid: string,
    id: string,
    input: unknown,
    etag?: string,
  ): Promise<CalendarEvent> {
    const escapedId = eventId(id);
    const event = validateEvent(input);
    const grant = await this.accessToken(uid);
    const currentEtag = await this.editableEvent(grant.token, escapedId, etag);
    // The preflight GET is an await boundary: disconnect may finish while it is in flight.
    await this.assertCurrentConnection(uid, grant.revision);
    return publicEvent(
      await this.deps.google.request(
        grant.token,
        `/calendars/primary/events/${escapedId}?sendUpdates=none`,
        'PATCH',
        event,
        currentEtag,
      ),
    );
  }
  async deleteEvent(uid: string, id: string, etag?: string): Promise<void> {
    const escapedId = eventId(id);
    const grant = await this.accessToken(uid);
    const currentEtag = await this.editableEvent(grant.token, escapedId, etag);
    // The preflight GET is an await boundary: disconnect may finish while it is in flight.
    await this.assertCurrentConnection(uid, grant.revision);
    await this.deps.google.request(
      grant.token,
      `/calendars/primary/events/${escapedId}?sendUpdates=none`,
      'DELETE',
      undefined,
      currentEtag,
    );
  }
}
