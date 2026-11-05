# Interactive Google Calendar view

Antty renders FullCalendar Standard month, week and day views using the existing
human Calendar API grant. There is no Google iframe or dependency on a separately
logged-in Google browser session. Connect the personal API grant under connection
settings; the account must match the verified Firebase Google identity.

## Supported operations

- Read the primary calendar for the visible date range, including all returned pages.
- Create ordinary personal timed or all-day events by button, date click or range selection.
- Edit title, description, location and dates/times in the editor.
- Drag to reschedule, resize to change duration, and explicitly confirm deletion.
- Updates and deletes submit the event's ETag. The existing backend rechecks the
  event and sends Google's `If-Match`; conflicts require refresh, never overwrite.
- Recurring instances, invited/participant events, foreign-organizer events,
  special event types, locked events and events missing ETags are view-only.
  Open Google Calendar for unsupported operations. No recurrence, attendee,
  multi-calendar, calendar sharing or AI features are added by this change.

Google-side changes are loaded when the visible range changes or the person clicks
Refresh. This phase does not add push notifications, incremental sync or background
polling. Pagination must finish before events are published or writes enabled;
an error never presents the partially loaded list as complete.

## Dates and skinning

Timed events display and edit in the browser's IANA timezone, shown in the header
and editor. New/changed times are sent as explicit UTC instants plus that zone.
Untouched timed fields retain their original offset, seconds and zone, including
the later occurrence of a repeated DST hour. Nonexistent local times are rejected.
For a newly entered repeated DST time, JavaScript chooses its first occurrence;
the editor explains this. Timezone selection is outside this first phase.

All-day dates never pass through the browser timezone. Google and FullCalendar use
exclusive ends; the editor shows an inclusive final date and converts at the boundary.

`components/calendar.css` scopes FullCalendar overrides to `.antty-calendar`.
The `--calendar-*` variables define the accent, borders, surface, text and muted
background. Future skins can override those without touching authorization or data
operations. Light/dark colors and a wrapping mobile toolbar are included.

## Safety and identity

Events and drafts stay in React memory, never local storage. Changing Firebase UID
remounts the workspace; changing the User object, range or connection invalidates
pending requests. Every token wait, fetch and JSON response checks its abort signal.
Late responses cannot populate a different account or range. Each call uses the
Firebase bearer token and only `/api/calendar`, never `/api/calendar-agent`.
Human/AI OAuth clients, grants and server boundaries remain independent.

A synchronous write lock prevents double submissions. A failed/uncertain mutation
or ETag conflict blocks further writes until a complete successful refresh. Drag
and resize failures revert immediately. Mutations are never automatically retried;
after an uncertain create, refresh and inspect the calendar before creating again.
Refresh closes the old draft. These are client-session safeguards, not server-side
idempotency across browsers or tabs. Provider errors use fixed public messages.

While a write is pending, the calendar and connection settings are inert. Reads
requested during that write are deferred. Successful writes trigger a complete
fresh read before editing resumes; failures keep editing blocked for an explicit
refresh. Read invalidation never cancels or unlocks a pending write.

Existing embed URLs saved by the previous implementation are no longer read or
rendered. This change does not automatically delete existing browser settings.

## Licensing and costs

The pinned FullCalendar 6.1.20 core/react/daygrid/timegrid/interaction packages use
the MIT license (including commercial use). No Premium or Scheduler package/key
is installed. Keep dependency copyright and license notices.

As checked on 2026-11-05, Google's Calendar API usage guide states standard usage
has no additional cost and describes a daily per-project billing threshold of
1,000,000 requests. It lists 10,000 requests/minute/project and 600/minute/user/project
for the updated quota model; projects with prior usage may retain older quotas.
The guide says over-threshold billing details will be announced with at least 90
days' notice. Do not promise unlimited free usage or invent an overage price.
Check the actual project's Cloud Console quota and current policy before activation.
Hosting, Firestore and any AI-model usage have separate billing policies.

## Verification boundaries

Unit and UI tests use synthetic events, tokens and provider responses. They cover
date boundaries/DST, pagination, CRUD payloads/ETags, duplicate submissions, conflict
rollback, stale account/range responses, readonly behavior, and the actual
FullCalendar month/week/day rendering. The existing native-server and security
suites remain required. A local synthetic preview can validate layout without
logging in or modifying a real calendar.

Feature-branch automatic deployment is disabled in `vercel.json`. No deployment,
Google configuration, credential, scope expansion, grant or real event is changed.
Production OAuth longevity, the independent AI workflow and authenticated real
Google read/write testing remain separate activation tasks requiring approval.

Known UX limitation: opening or refreshing connection settings can reset the
calendar to today's month and close an unsaved editor while status is rechecked.

## References

- https://fullcalendar.io/license
- https://github.com/fullcalendar/fullcalendar/tree/v6.1.20
- https://developers.google.com/workspace/calendar/api/guides/quota
- https://developers.google.com/workspace/calendar/api/v3/reference/events
- `docs/calendar-workflows.md`
