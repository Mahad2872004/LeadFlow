# LeadFlow

A local, fictional lead-management demo built with React, TypeScript, Vite, and plain CSS. No account, API key, backend, or paid service is required.

## Run locally

Use Node.js 22.12+ (Node 24 recommended) and npm. From this folder:

```powershell
npm install
npm run dev
```

Open the Local URL printed by Vite (normally http://localhost:5173).

```powershell
npm run build
npm run preview
npm run lint
npm test
```

Browser tests use Microsoft Edge installed on the machine. To use Playwright Chromium instead, remove `channel: 'msedge'` in `playwright.config.ts` and run `npx playwright install chromium` once. Tests start a local Vite server automatically and use isolated browser contexts; they do not change your normal browser's data.

## M1 features

- Overview with actionable metric cards, interactive pipeline breakdown, five recent leads, and due follow-up summary.
- Lead creation and full contact editing with shared validation. Open a lead and choose Edit lead; Cancel discards unsaved changes.
- Search across name, company, email, and service; combined status/source filters and five editable lead statuses.
- Lead details, follow-up scheduling, completion/reopening, and timestamped activity history.
- Open/due/overdue/upcoming/completed/all task filters, due indicators, simulated in-app notifications.
- Fictional initial data, confirmed reset, responsive navigation and forms.
- Versioned localStorage persistence with schema checks and explicit failure messages.

## Structure

- `src/lib/model.ts`: domain types, validation, and immutable lead/task operations.
- `src/lib/storage.ts`: centralized serialization, loading, schema checks, and storage errors.
- `src/lib/dates.ts`: strict local calendar-date validation and shared due/state calculations.
- `src/hooks/useLocalDay.ts`: local-midnight and tab-return refresh for date-based state.
- `src/lib/seed.ts`: fictional sample records; task dates are relative to the local day.
- `src/components/`: reusable Sidebar, MetricCard, DashboardOverview, LeadTable, TaskList, ActivityTimeline, LeadForm, NotificationCenter, Icon, and accessible Modal components.
- `src/App.tsx`: workspace state, view composition, forms, and action handlers.
- `src/App.css`: responsive design system and component styles.
- `tests/leadflow.spec.ts`: end-to-end browser regression tests.

## Persistence and limits

Data uses the `leadflow.demo.v1` key and belongs to the current browser and origin (including port). Reset replaces that key only. Clearing browser data removes the demo. Invalid saved data is preserved until an explicit reset; changes made while recovery is blocked remain in memory. Storage write failures also leave the session usable with a visible warning.

This is a single-browser demonstration, not a production CRM. There is no authentication, server, cross-device synchronization, email delivery, external integration, background reminder service, or multi-tab conflict resolution. Notifications are simulated and session-only. Contact editing preserves the lead ID, creation date, linked tasks, and previous activity. Lead deletion is outside this implementation. Avoid entering sensitive real customer information in a shared browser.

## Testing

`npm test` covers lead validation, creation, full editing, cancel behavior, automatic dashboard counts, search/filtering, status changes, refresh persistence, task creation/completion and history, reset/cancel, corrupt storage recovery, failed writes, empty results, mobile overflow, and browser runtime errors. Responsive interaction tests cover 360px, 768px, and 1440px viewports, including mobile lead cards and dashboard shortcuts. Screenshots are saved under ignored `test-results/`.



## Follow-up dates and history

Follow-ups store due dates as local calendar dates (`YYYY-MM-DD`), without converting them into UTC timestamps. A task is due if it is incomplete and its date is today or earlier. It becomes overdue on the following local calendar day. Completed tasks are excluded from due and overdue totals; reopening restores the appropriate state. Past dates are allowed, while impossible calendar dates, empty notes, and notes longer than 2,000 characters are rejected.

The dashboard, task filters, and task badges share the same date rules. They refresh at local midnight and when the browser tab regains focus or visibility. Activity timestamps are stored as ISO timestamps and displayed in the viewer's local time. Lead creation, edits, status changes, task scheduling, completion, and reopening appear newest first in both workspace and lead timelines.

`tests/followups.spec.ts` verifies leap years, invalid dates, task validation, completion/reopening, persisted history, and a browser-clock test crossing local midnight in Asia/Karachi.

## Notifications and UI feedback

The notification bell opens a keyboard-accessible dialog containing recent lead/task actions and current due/overdue reminders. View follow-up opens the associated lead. Dismiss and Clear all remove notifications for the current session without completing tasks. Reminders can return on the next local day or refresh; completing a task removes its reminder. Reset replaces old event notifications and clears reminder dismissals. No email, push, or messaging integration is used.

Dialogs have accessible names, contain keyboard focus, close with Escape, and restore focus to their opener. Search results are announced, forms validate required fields, and mobile controls use larger touch targets. Clear filters recovers from empty searches. Failed writes show Retry saving without discarding in-memory changes; unreadable saved data remains protected until confirmed reset. Reset cancellation leaves data untouched and confirmation only replaces LeadFlow's own storage key.

`tests/polish.spec.ts` exercises notification actions, keyboard focus, all metric/pipeline shortcuts, mobile notification layout, empty workspace actions, reset cancellation/confirmation, unrelated storage preservation, and recovery from failed writes. Existing suites cover lead creation/editing, forms, status controls, task actions, timelines, persistence, and calendar boundaries. Accessibility checks cover these keyboard and semantic behaviors; they are not a formal WCAG audit.

## M1 audit — 18 October 2026

Implemented audit fixes:
- Saved-data validation now rejects duplicate/empty IDs, invalid lead fields, missing task/activity lead references, invalid timestamps, and empty task notes. Invalid stored data is preserved for recovery.
- Visible dates include the year to distinguish follow-ups across calendar years.
- Added audit regression coverage and a production-preview test configuration.

Verified on this machine (Microsoft Edge, Windows):
- `npm run build`: passed (TypeScript and Vite production build).
- `npm run lint`: passed without findings.
- `npm test`: 23 tests passed against Vite development server.
- `npm run test:production`: the same 23 tests passed against built `dist` assets served by Vite preview.
- Browser tests cover lead creation/editing/cancel, validation, all five statuses and live metrics, combined search/filters, refresh persistence, follow-up creation/completion/reopening, local midnight and leap-year rules, activity history, simulated notifications, reset/cancel, unrelated storage preservation, malformed data, quota failure/retry, keyboard focus, navigation, and empty states.
- Responsive checks cover 320, 360, 390, 768, and 1440 pixel widths, including a 320×568 viewport with maximum-length contact/message fields. Desktop and small-screen screenshots were visually inspected.

Reproduce production verification after any source changes:

```powershell
npm run build
npm run lint
npm test
npm run test:production
```

Not tested: Safari/Firefox, physical mobile devices, screen-reader software, a formal WCAG audit, large-data performance, multi-tab concurrency, daylight-saving transitions, or real email/phone handler launches (link targets were checked only). No external messaging or backend exists. Multi-tab conflict resolution is not supported. Notifications and reminder dismissals remain session-only by design; leads, tasks, and activity persist in localStorage. Test servers are automatically stopped by Playwright after the runs.
