import { CalendarError, type CalendarChannel } from './core.js';
import { createCipher } from './security.js';

export interface CalendarConfig {
  channel: CalendarChannel;
  projectId: string;
  clientId: string;
  clientSecret: string;
  appOrigin: string;
  redirectUri: string;
  encryptionKey: string;
}
export function calendarConfig(
  env: Record<string, string | undefined> = process.env,
  channel: CalendarChannel = 'ui',
): CalendarConfig {
  if (channel !== 'ui' && channel !== 'agent')
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  const agent = channel === 'agent';
  const clientId = agent ? env.GOOGLE_CALENDAR_AGENT_CLIENT_ID : env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = agent
    ? env.GOOGLE_CALENDAR_AGENT_CLIENT_SECRET
    : env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const projectId = agent ? env.GOOGLE_CALENDAR_AGENT_PROJECT_ID : env.GOOGLE_CALENDAR_PROJECT_ID;
  const appOrigin = env.CALENDAR_APP_ORIGIN;
  const encryptionKey = agent
    ? env.CALENDAR_AGENT_TOKEN_ENCRYPTION_KEY
    : env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (
    !clientId ||
    !clientSecret ||
    !projectId ||
    !appOrigin ||
    !encryptionKey ||
    !env.FIREBASE_PROJECT_ID
  )
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[A-Za-z0-9._-]+$/.test(clientId))
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  if (agent) {
    const interactive = calendarConfig(env, 'ui');
    // Operator declarations are a deployment gate, not evidence from Google. Verify both projects
    // and the agent designation in Cloud Console before setting these values. Client IDs alone
    // cannot establish project ownership, and revocation affects ALL clients in one project.
    if (
      env.GOOGLE_CALENDAR_AGENT_CLIENT_CONFIRMED !== 'true' ||
      projectId === interactive.projectId ||
      clientId === interactive.clientId ||
      encryptionKey === interactive.encryptionKey
    )
      throw new CalendarError('CALENDAR_NOT_CONFIGURED', 503);
  }
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
    channel,
    projectId,
    clientId,
    clientSecret,
    appOrigin,
    encryptionKey,
    redirectUri: `${appOrigin}/api/${agent ? 'calendar-agent' : 'calendar'}?action=callback`,
  };
}
