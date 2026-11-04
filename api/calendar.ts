import { authenticateRequest } from '../server/firebase.js';
import { calendarConfig } from '../server/calendar/config.js';
import { createCalendarHandler } from '../server/calendar/http.js';
import { getCalendarService, getCalendarStatus } from '../server/calendar/service.js';

export default createCalendarHandler({
  authenticate: authenticateRequest,
  service: getCalendarService,
  status: getCalendarStatus,
  origin: () => calendarConfig().appOrigin,
});
