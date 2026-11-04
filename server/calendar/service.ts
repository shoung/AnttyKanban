import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from '../firebase.js';
import {
  CalendarError,
  CalendarService,
  type CalendarChannel,
  type CalendarConnection,
  type CalendarListInput,
  type CalendarStore,
  type CalendarStatus,
  type OAuthAttempt,
} from './core.js';
import { calendarConfig } from './config.js';
import { createCipher } from './security.js';
import { googleGateway } from './google.js';

/** These collections must have NO browser-readable or browser-writable matching allow rule. */
const CONNECTIONS = 'calendarConnections';
const ATTEMPTS = 'calendarOAuthStates';
export function createCalendarStore(
  channel: CalendarChannel,
  db: ReturnType<typeof getAdminDb> = getAdminDb(),
): CalendarStore {
  if (channel !== 'ui' && channel !== 'agent')
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  const connectionRef = (uid: string) =>
    db.collection(CONNECTIONS).doc(uid).collection('grants').doc(channel);
  const attemptRef = (key: string) =>
    db.collection(ATTEMPTS).doc(channel).collection('attempts').doc(key);
  return {
    ...(channel === 'ui'
      ? {
          async hasLegacyConnection(uid: string) {
            const legacy = await db.collection(CONNECTIONS).doc(uid).get();
            // The pre-split document is never migrated, deleted or returned to either workflow.
            // Only the human UI receives a reconnect marker. Agent code never reads legacy data.
            return Boolean(legacy.exists && legacy.data()?.encryptedRefreshToken);
          },
        }
      : {}),
    async getConnection(uid) {
      const snapshot = await connectionRef(uid).get();
      return snapshot.exists ? (snapshot.data() as CalendarConnection) : null;
    },
    async saveConnection(uid, value, expectedRevision) {
      const ref = connectionRef(uid);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if ((snapshot.data()?.revision ?? 0) !== expectedRevision) return false;
        transaction.set(ref, JSON.parse(JSON.stringify(value)) as CalendarConnection);
        return true;
      });
    },
    async createAttempt(key, attempt) {
      await attemptRef(key).create({
        ...attempt,
        expireAt: Timestamp.fromMillis(attempt.expiresAt),
      });
    },
    async consumeAttempt(key, bindingHash, now) {
      const ref = attemptRef(key);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const attempt = snapshot.data() as OAuthAttempt;
        if (
          attempt.channel !== channel ||
          attempt.bindingHash !== bindingHash ||
          attempt.expiresAt <= now
        )
          return null;
        transaction.delete(ref);
        return attempt;
      });
    },
  };
}
export function getCalendarService(channel: CalendarChannel = 'ui'): CalendarService {
  const config = calendarConfig(process.env, channel);
  return new CalendarService({
    context: { channel, clientId: config.clientId, projectId: config.projectId },
    store: createCalendarStore(channel),
    google: googleGateway(config),
    cipher: createCipher(config.encryptionKey),
    expectedGoogleSubject: async (uid) => {
      const user = await getAdminAuth().getUser(uid);
      if (user.disabled) throw new CalendarError('AUTHENTICATION_REQUIRED', 401);
      const subject = user.providerData.find(
        (provider) => provider.providerId === 'google.com',
      )?.uid;
      if (!subject) throw new CalendarError('GOOGLE_LOGIN_REQUIRED', 409);
      return subject;
    },
  });
}
export async function getCalendarStatus(
  uid: string,
  channel: CalendarChannel = 'ui',
): Promise<CalendarStatus> {
  try {
    return await getCalendarService(channel).getStatus(uid);
  } catch (error) {
    if (error instanceof CalendarError && error.code === 'CALENDAR_NOT_CONFIGURED')
      return { configured: false, status: 'not_configured', calendar: 'primary' };
    throw error;
  }
}
export const beginCalendarConnect = (uid: string, browserBinding: string) =>
  getCalendarService().beginConnect(uid, browserBinding);
export const completeCalendarConnect = (state: string, browserBinding: string, code: string) =>
  getCalendarService().completeConnect(state, browserBinding, code);
export const disconnectCalendar = (uid: string, confirmProjectRevocation: boolean) =>
  getCalendarService().disconnect(uid, confirmProjectRevocation);
export const listCalendarEvents = (uid: string, input: CalendarListInput = {}) =>
  getCalendarService().listEvents(uid, input);
export const createCalendarEvent = (uid: string, input: unknown) =>
  getCalendarService().createEvent(uid, input);
export const updateCalendarEvent = (uid: string, eventId: string, input: unknown, etag?: string) =>
  getCalendarService().updateEvent(uid, eventId, input, etag);
export const deleteCalendarEvent = (uid: string, eventId: string, etag?: string) =>
  getCalendarService().deleteEvent(uid, eventId, etag);
/** Only MCP's authenticated UID adapter may use these operations. Never fall back to UI grants. */
export const agentCalendarOperations = Object.freeze({
  getCalendarStatus: (uid: string) => getCalendarStatus(uid, 'agent'),
  listCalendarEvents: (uid: string, input: CalendarListInput = {}) =>
    getCalendarService('agent').listEvents(uid, input),
  createCalendarEvent: (uid: string, input: unknown) =>
    getCalendarService('agent').createEvent(uid, input),
  updateCalendarEvent: (uid: string, eventId: string, input: unknown, etag?: string) =>
    getCalendarService('agent').updateEvent(uid, eventId, input, etag),
  deleteCalendarEvent: (uid: string, eventId: string, etag?: string) =>
    getCalendarService('agent').deleteEvent(uid, eventId, etag),
});
export type {
  CalendarChannel,
  CalendarEvent,
  CalendarEventInput,
  CalendarListInput,
  CalendarStatus,
} from './core.js';
