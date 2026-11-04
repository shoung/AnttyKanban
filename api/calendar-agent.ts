import { authenticateRequest } from '../server/firebase.js';
import { calendarConfig } from '../server/calendar/config.js';
import { createCalendarHandler } from '../server/calendar/http.js';
import { getCalendarService, getCalendarStatus } from '../server/calendar/service.js';

// Only the authenticated person can manage this grant. MCP never starts consent.
export default createCalendarHandler(
  {
    authenticate: authenticateRequest,
    service: () => getCalendarService('agent'),
    status: (uid) => getCalendarStatus(uid, 'agent'),
    origin: () => calendarConfig(process.env, 'agent').appOrigin,
  },
  { workflow: 'agent' },
);
