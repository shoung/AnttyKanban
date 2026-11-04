import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminDb } from '../firebase';
import {
  CalendarError,
  CalendarService,
  type CalendarConnection,
  type CalendarListInput,
  type CalendarStore,
  type CalendarStatus,
  type OAuthAttempt,
} from './core.ts';
import { calendarConfig } from './config.ts';
import { createCipher } from './security.ts';
import { googleGateway } from './google.ts';

/** These collections must have NO browser-readable or browser-writable matching allow rule. */
const CONNECTIONS = 'calendarConnections';
const ATTEMPTS = 'calendarOAuthStates';
function firestoreStore(): CalendarStore {
  const db = getAdminDb();
  return {
    async getConnection(uid) {
      const snapshot = await db.collection(CONNECTIONS).doc(uid).get();
      return snapshot.exists ? (snapshot.data() as CalendarConnection) : null;
    },
    async saveConnection(uid, value, expectedRevision) {
      const ref = db.collection(CONNECTIONS).doc(uid);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if ((snapshot.data()?.revision ?? 0) !== expectedRevision) return false;
        transaction.set(ref, JSON.parse(JSON.stringify(value)) as CalendarConnection);
        return true;
      });
    },
    async createAttempt(key, attempt) {
      await db
        .collection(ATTEMPTS)
        .doc(key)
        .create({ ...attempt, expireAt: Timestamp.fromMillis(attempt.expiresAt) });
    },
    async consumeAttempt(key, bindingHash, now) {
      const ref = db.collection(ATTEMPTS).doc(key);
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const attempt = snapshot.data() as OAuthAttempt;
        if (attempt.bindingHash !== bindingHash || attempt.expiresAt <= now) return null;
        transaction.delete(ref);
        return attempt;
      });
    },
  };
}
export function getCalendarService(): CalendarService {
  const config = calendarConfig();
  return new CalendarService({
    store: firestoreStore(),
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
export async function getCalendarStatus(uid: string): Promise<CalendarStatus> {
  try {
    return await getCalendarService().getStatus(uid);
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
export type {
  CalendarEvent,
  CalendarEventInput,
  CalendarListInput,
  CalendarStatus,
} from './core.ts';
