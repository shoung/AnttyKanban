# Native Google Calendar view

The Calendar workspace displays Google's official embedded calendar. It does not
reimplement Google's event editor or promise full CRUD inside the iframe. Buttons
open Google Calendar in a new tab for creating, editing, or deleting events. The
new-event link opens an unsaved draft; it does not create an event automatically.

## Set up the view

In Google Calendar, open Settings → Settings for my calendars → Integrate calendar.
Copy only the `src` URL from the official embed code, not the HTML or a private iCal
address, and paste it in Antty's calendar display settings. One calendar is supported.
Only HTTPS URLs at `calendar.google.com/calendar/embed` with validated display
parameters are accepted. No calendar identifier is inferred from the Antty account.

The URL is stored in this browser's local storage under the signed-in Firebase UID.
It is not uploaded to Antty's backend. Rendering necessarily sends the URL and its
calendar identifier to Google. This is account-separated UI state, not encryption
or a confidentiality boundary against another person with access to the same browser.
Clear the display setting on shared devices and check the Google browser account.

Private calendars need not be made public. Google controls their visibility using
its own signed-in browser session and sharing permissions. Antty login and Calendar
API OAuth grants do not log in the iframe. Third-party-cookie restrictions, a different
Google account, or an unavailable Google session can prevent the view from appearing.
Use the external Google Calendar button in that case. The app cannot inspect a
cross-origin iframe to assert that a private calendar loaded successfully.

## Authorization remains separate

The collapsed connection settings retain human API and AI Calendar grant controls.
They do not load events on the ordinary calendar view. OAuth callback markers open
those settings so a connection result can be shown. No OAuth or Firebase tokens are
placed in iframe URLs. Existing API services, stored grants, and independent AI
Calendar permissions are unchanged; this feature does not automatically revoke them.

## Verification boundaries

Automated tests cover URL rejection/canonicalization, per-UID remounting, local-storage
failures, safe external links, iframe restrictions, callback handling, and absence of
custom event mutation calls. An actual private Google calendar must still be checked
in the intended signed-in browser; unit tests cannot establish Google cookie behavior.
Feature-branch automatic deployments are disabled. No Calendar sharing permissions,
Google consent, or real events are changed by the implementation tests.

## References

- Official embed instructions: https://support.google.com/calendar/answer/41207
- Embedded calendar update: https://workspaceupdates.googleblog.com/2024/09/update-look-and-feel-embedded-google-calendars.html
- Native event-template links: https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events
