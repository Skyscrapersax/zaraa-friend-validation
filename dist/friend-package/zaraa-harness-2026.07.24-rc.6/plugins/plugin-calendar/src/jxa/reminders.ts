/**
 * JXA (JavaScript for Automation) script builders for macOS Reminders.app.
 *
 * Each builder returns a self-contained JavaScript program intended to be run
 * via `osascript -l JavaScript -e <script>`. Scripts emit a JSON string as
 * their final expression.
 *
 * Reminders.app priority is an integer (0 = none, 1 = high, 5 = medium,
 * 9 = low — Apple's EventKit convention). We translate to/from the named
 * priorities used in the tool params.
 */

import { toJxaLiteral } from "./calendar.js";

export { toJxaLiteral };

/** Map a named priority to the EventKit integer used by Reminders.app. */
const PRIORITY_TO_INT: Record<string, number> = {
	none: 0,
	high: 1,
	medium: 5,
	low: 9,
};

/** Inline JS source that maps an EventKit integer priority to a name. */
const PRIORITY_NAME_FN = `
function priorityName(p) {
  if (p === 0) return "none";
  if (p >= 1 && p <= 4) return "high";
  if (p === 5) return "medium";
  if (p >= 6) return "low";
  return "none";
}`;

/** JXA program: list reminders, optionally filtered by list / completion. */
export function buildListScript(params: { listName?: string; includeCompleted?: boolean }): string {
	const listName = toJxaLiteral(params.listName ?? null);
	const includeCompleted = toJxaLiteral(params.includeCompleted ?? false);
	return `
(function () {
  var app = Application("Reminders");
  ${PRIORITY_NAME_FN}
  var listName = ${listName};
  var includeCompleted = ${includeCompleted};
  var lists = listName ? app.lists.whose({ name: listName }) : app.lists;
  var out = [];
  var n = lists.length;
  for (var i = 0; i < n; i++) {
    var lst = lists[i];
    var thisListName = lst.name();
    var rems = includeCompleted ? lst.reminders : lst.reminders.whose({ completed: false });
    var m = rems.length;
    for (var j = 0; j < m; j++) {
      var r = rems[j];
      var due = null;
      try { var d = r.dueDate(); if (d) { due = d.toISOString(); } } catch (err) { due = null; }
      var notes = null;
      try { notes = r.body(); } catch (err) { notes = null; }
      out.push({
        id: r.id(),
        listName: thisListName,
        title: r.name(),
        dueISO: due || undefined,
        completed: r.completed(),
        priority: priorityName(r.priority()),
        notes: notes || undefined,
      });
    }
  }
  return JSON.stringify(out);
})();`;
}

/** JXA program: create a reminder. Returns { id, listName }. */
export function buildCreateScript(params: {
	title: string;
	dueISO?: string;
	listName?: string;
	priority?: "none" | "low" | "medium" | "high";
	notes?: string;
}): string {
	const title = toJxaLiteral(params.title);
	const dueISO = toJxaLiteral(params.dueISO ?? null);
	const listName = toJxaLiteral(params.listName ?? null);
	const priorityInt = toJxaLiteral(PRIORITY_TO_INT[params.priority ?? "none"] ?? 0);
	const notes = toJxaLiteral(params.notes ?? null);
	return `
(function () {
  var app = Application("Reminders");
  var listName = ${listName};
  var lst;
  if (listName) {
    var matches = app.lists.whose({ name: listName });
    if (matches.length === 0) { throw new Error("Reminder list not found: " + listName); }
    lst = matches[0];
  } else {
    lst = app.defaultList();
  }
  var props = { name: ${title}, priority: ${priorityInt} };
  var dueISO = ${dueISO};
  if (dueISO) { props.dueDate = new Date(dueISO); }
  var notes = ${notes};
  if (notes) { props.body = notes; }
  var rem = app.Reminder(props);
  lst.reminders.push(rem);
  return JSON.stringify({ id: rem.id(), listName: lst.name() });
})();`;
}

/** JXA program: mark the first matching incomplete reminder as completed. */
export function buildCompleteScript(params: { title: string; listName?: string }): string {
	const title = toJxaLiteral(params.title);
	const listName = toJxaLiteral(params.listName ?? null);
	return `
(function () {
  var app = Application("Reminders");
  var title = ${title};
  var listName = ${listName};
  var lists = listName ? app.lists.whose({ name: listName }) : app.lists;
  var n = lists.length;
  for (var i = 0; i < n; i++) {
    var matches = lists[i].reminders.whose({ _and: [{ name: title }, { completed: false }] });
    if (matches.length > 0) {
      var r = matches[0];
      r.completed = true;
      return JSON.stringify({ id: r.id(), listName: lists[i].name(), completed: true });
    }
  }
  throw new Error("Reminder not found: " + title);
})();`;
}
