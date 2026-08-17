// src/calendar/calendar-tools.ts
var manifest = {
  name: "calendar",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["calendar.management"],
  trust: "core",
  tools: [
    {
      name: "cal_list_events",
      description: "List events in date range",
      parameters: {
        type: "object",
        properties: {
          start: {
            type: "string",
            description: "Start date/time in ISO 8601 format"
          },
          end: {
            type: "string",
            description: "End date/time in ISO 8601 format"
          },
          provider: {
            type: "string",
            description: "Calendar provider name (e.g. 'apple', 'google'). Omit to query all."
          },
          calendarId: {
            type: "string",
            description: "Specific calendar ID to filter events"
          }
        },
        required: ["start", "end"]
      },
      requiresApproval: false
    },
    {
      name: "cal_create_event",
      description: "Create a new calendar event",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Calendar provider name"
          },
          calendarId: {
            type: "string",
            description: "Calendar ID to create the event in"
          },
          calendarName: {
            type: "string",
            description: "Display name of the calendar"
          },
          title: {
            type: "string",
            description: "Event title"
          },
          startDate: {
            type: "string",
            description: "Start date/time in ISO 8601 format"
          },
          endDate: {
            type: "string",
            description: "End date/time in ISO 8601 format"
          },
          location: {
            type: "string",
            description: "Event location"
          },
          notes: {
            type: "string",
            description: "Event notes or description"
          },
          isAllDay: {
            type: "boolean",
            description: "Whether this is an all-day event (default: false)"
          }
        },
        required: [
          "provider",
          "calendarId",
          "calendarName",
          "title",
          "startDate",
          "endDate"
        ]
      },
      requiresApproval: true
    },
    {
      name: "cal_modify_event",
      description: "Modify an existing calendar event",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Calendar provider name"
          },
          id: {
            type: "string",
            description: "Event ID to modify"
          },
          title: {
            type: "string",
            description: "New event title"
          },
          startDate: {
            type: "string",
            description: "New start date/time in ISO 8601"
          },
          endDate: {
            type: "string",
            description: "New end date/time in ISO 8601"
          },
          location: {
            type: "string",
            description: "New event location"
          },
          notes: {
            type: "string",
            description: "New event notes"
          },
          isAllDay: {
            type: "boolean",
            description: "Whether this is an all-day event"
          }
        },
        required: ["provider", "id"]
      },
      requiresApproval: true
    },
    {
      name: "cal_delete_event",
      description: "Delete a calendar event",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Calendar provider name"
          },
          id: {
            type: "string",
            description: "Event ID to delete"
          }
        },
        required: ["provider", "id"]
      },
      requiresApproval: true
    },
    {
      name: "cal_list_calendars",
      description: "List available calendars from a provider (useful for getting calendar IDs before creating events)",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Calendar provider name (e.g. 'apple', 'google')"
          }
        },
        required: ["provider"]
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(store) {
  return {
    cal_list_events: async (args) => {
      const start = args.start;
      const end = args.end;
      if (!start || !end) {
        throw new Error("start and end are required");
      }
      const provider = args.provider;
      const calendarId = args.calendarId;
      const events = await store.listEvents(start, end, {
        providerName: provider,
        calendarId
      });
      return JSON.stringify(events);
    },
    cal_create_event: async (args) => {
      const provider = args.provider;
      const calendarId = args.calendarId;
      const calendarName = args.calendarName;
      const title = args.title;
      const startDate = args.startDate;
      const endDate = args.endDate;
      if (!provider || !calendarId || !calendarName || !title || !startDate || !endDate) {
        throw new Error(
          "provider, calendarId, calendarName, title, startDate, and endDate are required"
        );
      }
      const event = await store.createEvent(provider, {
        calendarId,
        calendarName,
        title,
        startDate,
        endDate,
        location: args.location,
        notes: args.notes,
        isAllDay: args.isAllDay ?? false
      });
      return JSON.stringify(event);
    },
    cal_modify_event: async (args) => {
      const provider = args.provider;
      const id = args.id;
      if (!provider || !id) {
        throw new Error("provider and id are required");
      }
      const changes = {};
      if (args.title !== void 0) changes.title = args.title;
      if (args.startDate !== void 0)
        changes.startDate = args.startDate;
      if (args.endDate !== void 0) changes.endDate = args.endDate;
      if (args.location !== void 0) changes.location = args.location;
      if (args.notes !== void 0) changes.notes = args.notes;
      if (args.isAllDay !== void 0) changes.isAllDay = args.isAllDay;
      const event = await store.modifyEvent(provider, id, changes);
      return JSON.stringify(event);
    },
    cal_delete_event: async (args) => {
      const provider = args.provider;
      const id = args.id;
      if (!provider || !id) {
        throw new Error("provider and id are required");
      }
      await store.deleteEvent(provider, id);
      return JSON.stringify({ success: true, id });
    },
    cal_list_calendars: async (args) => {
      const provider = args.provider;
      if (!provider) {
        throw new Error("provider is required");
      }
      const calendars = await store.listCalendars(provider);
      return JSON.stringify(calendars);
    }
  };
}

export {
  manifest,
  createHandlers
};
