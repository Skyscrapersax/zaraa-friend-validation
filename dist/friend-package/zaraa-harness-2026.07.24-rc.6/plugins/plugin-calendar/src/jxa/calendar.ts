/**
 * JXA (JavaScript for Automation) script builders for macOS Calendar.app.
 *
 * Each builder returns a self-contained JavaScript program intended to be run
 * via `osascript -l JavaScript -e <script>`. The scripts always emit a JSON
 * string as their final expression so the handler layer can `JSON.parse` the
 * stdout with no tab-delimited parsing.
 *
 * JXA exposes Calendar.app via `Application("Calendar")`. Event date objects
 * are JS `Date`s, so `.toISOString()` yields clean ISO-8601 output.
 */

/**
 * Serialize a JS value into a JXA literal. Used to inject user-supplied
 * parameters into the script body without string-concatenation injection:
 * `JSON.stringify` produces a valid JavaScript expression for strings,
 * numbers, booleans and null, which the JXA interpreter evaluates safely.
 */
export function toJxaLiteral(value: unknown): string {
	return JSON.stringify(value ?? null);
}

/**
 * Shared JXA helper source injected at the top of every read script. Collects
 * events from the requested calendars within [startMs, endMs] and maps them to
 * the plugin's CalendarEvent shape.
 */
const COLLECT_EVENTS_FN = `
function collectEvents(app, calName, startDate, endDate) {
  var out = [];
  var cals = calName ? app.calendars.whose({ name: calName }) : app.calendars;
  var n = cals.length;
  for (var i = 0; i < n; i++) {
    var cal = cals[i];
    var thisCalName = cal.name();
    var evts = cal.events.whose({
      _and: [{ startDate: { _greaterThanEquals: startDate } }, { startDate: { _lessThan: endDate } }],
    });
    var m = evts.length;
    for (var j = 0; j < m; j++) {
      var e = evts[j];
      var loc = null;
      try { loc = e.location(); } catch (err) { loc = null; }
      var notes = null;
      try { notes = e.notes(); } catch (err) { notes = null; }
      out.push({
        id: e.uid(),
        calendarName: thisCalName,
        title: e.summary(),
        startISO: e.startDate().toISOString(),
        endISO: e.endDate().toISOString(),
        location: loc || undefined,
        notes: notes || undefined,
        allDay: e.alldayEvent(),
      });
    }
  }
  out.sort(function (a, b) { return a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0; });
  return out;
}`;

/** JXA program: today's events (local midnight -> next midnight). */
export function buildTodayScript(params: { calendarName?: string }): string {
	const calName = toJxaLiteral(params.calendarName ?? null);
	return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var calName = ${calName};
  var start = new Date(); start.setHours(0, 0, 0, 0);
  var end = new Date(start.getTime()); end.setDate(end.getDate() + 1);
  return JSON.stringify(collectEvents(app, calName, start, end));
})();`;
}

/** JXA program: a week's events. weekOffset 0 = this week, 1 = next week. */
export function buildWeekScript(params: { calendarName?: string; weekOffset?: number }): string {
	const calName = toJxaLiteral(params.calendarName ?? null);
	const offset = toJxaLiteral(params.weekOffset ?? 0);
	return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var calName = ${calName};
  var offset = ${offset};
  var start = new Date(); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + offset * 7);
  var end = new Date(start.getTime()); end.setDate(end.getDate() + 7);
  return JSON.stringify(collectEvents(app, calName, start, end));
})();`;
}

/** JXA program: the next `limit` events within `days` lookahead. */
export function buildUpcomingScript(params: { limit: number; days?: number }): string {
	const limit = toJxaLiteral(params.limit);
	const days = toJxaLiteral(params.days ?? 14);
	return `
(function () {
  var app = Application("Calendar");
  ${COLLECT_EVENTS_FN}
  var limit = ${limit};
  var days = ${days};
  var start = new Date();
  var end = new Date(start.getTime()); end.setDate(end.getDate() + days);
  var all = collectEvents(app, null, start, end);
  return JSON.stringify(all.slice(0, limit));
})();`;
}

/** JXA program: create an event. Returns { id, calendarName }. */
export function buildCreateScript(params: {
	title: string;
	startISO: string;
	endISO: string;
	calendarName?: string;
	location?: string;
	notes?: string;
	allDay?: boolean;
}): string {
	const title = toJxaLiteral(params.title);
	const startISO = toJxaLiteral(params.startISO);
	const endISO = toJxaLiteral(params.endISO);
	const calName = toJxaLiteral(params.calendarName ?? null);
	const location = toJxaLiteral(params.location ?? null);
	const notes = toJxaLiteral(params.notes ?? null);
	const allDay = toJxaLiteral(params.allDay ?? false);
	return `
(function () {
  var app = Application("Calendar");
  var calName = ${calName};
  var cal;
  if (calName) {
    var matches = app.calendars.whose({ name: calName });
    if (matches.length === 0) { throw new Error("Calendar not found: " + calName); }
    cal = matches[0];
  } else {
    var writable = app.calendars.whose({ writable: true });
    if (writable.length === 0) { throw new Error("No writable calendar available"); }
    cal = writable[0];
  }
  var props = {
    summary: ${title},
    startDate: new Date(${startISO}),
    endDate: new Date(${endISO}),
    alldayEvent: ${allDay},
  };
  var location = ${location};
  if (location) { props.location = location; }
  var notes = ${notes};
  if (notes) { props.notes = notes; }
  var evt = app.Event(props);
  cal.events.push(evt);
  return JSON.stringify({ id: evt.uid(), calendarName: cal.name() });
})();`;
}
