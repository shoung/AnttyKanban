import { CalendarError } from './core.ts';
import { createCipher } from './security.ts';

export interface CalendarConfig {
  clientId: string;
  clientSecret: string;
  appOrigin: string;
  redirectUri: string;
  encryptionKey: string;
}
export function calendarConfig(
  env: Record<string, string | undefined> = process.env,
): CalendarConfig {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const appOrigin = env.CALENDAR_APP_ORIGIN;
  const encryptionKey = env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !appOrigin || !encryptionKey || !env.FIREBASE_PROJECT_ID)
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  }
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
  if (
    origin.origin !== appOrigin ||
    (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) ||
    origin.username ||
    origin.password
  )
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  try {
    createCipher(encryptionKey);
  } catch {
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  }
  return {
    clientId,
    clientSecret,
    appOrigin,
    encryptionKey,
    redirectUri: `${appOrigin}/api/calendar?action=callback`,
  };
}
