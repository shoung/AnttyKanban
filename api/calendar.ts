import { authenticateRequest } from '../server/firebase';
import { calendarConfig } from '../server/calendar/config';
import { createCalendarHandler } from '../server/calendar/http';
import { getCalendarService, getCalendarStatus } from '../server/calendar/service';

export default createCalendarHandler({
  authenticate: authenticateRequest,
  service: getCalendarService,
  status: getCalendarStatus,
  origin: () => calendarConfig().appOrigin,
});
