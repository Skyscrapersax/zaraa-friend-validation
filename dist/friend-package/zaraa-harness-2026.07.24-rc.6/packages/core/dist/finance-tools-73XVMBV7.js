import "./chunk-R5U7XKVJ.js";

// src/finance/finance-tools.ts
var manifest = {
  name: "finance",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["finance.tracking"],
  trust: "core",
  tools: [
    {
      name: "finance_log_time",
      description: "Log time worked on a project",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name" },
          hours: { type: "number", description: "Hours worked" },
          description: {
            type: "string",
            description: "What was done"
          },
          billable: {
            type: "boolean",
            description: "Whether this time is billable (default: true)"
          }
        },
        required: ["project", "hours", "description"]
      },
      requiresApproval: false
    },
    {
      name: "finance_log_expense",
      description: "Log an expense for a project",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name" },
          amount: { type: "number", description: "Expense amount" },
          category: {
            type: "string",
            description: "Expense category (e.g., software, hardware, services)"
          },
          description: {
            type: "string",
            description: "What the expense was for"
          }
        },
        required: ["project", "amount", "category", "description"]
      },
      requiresApproval: true
    },
    {
      name: "finance_log_revenue",
      description: "Log revenue received for a project",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project name" },
          amount: { type: "number", description: "Revenue amount" },
          description: {
            type: "string",
            description: "Revenue description"
          },
          status: {
            type: "string",
            enum: ["pending", "invoiced", "paid"],
            description: "Payment status"
          }
        },
        required: ["project", "amount", "description"]
      },
      requiresApproval: true
    },
    {
      name: "finance_summary",
      description: "Get financial summary for a project or monthly P&L",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project name (omit for monthly P&L)"
          },
          month: {
            type: "string",
            description: "Month in YYYY-MM format (for P&L)"
          }
        },
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(store) {
  return {
    finance_log_time: async (args) => {
      const entry = store.logTime({
        project: args.project,
        hours: args.hours,
        description: args.description,
        billable: args.billable
      });
      return JSON.stringify(entry);
    },
    finance_log_expense: async (args) => {
      const entry = store.logExpense({
        project: args.project,
        amount: args.amount,
        category: args.category,
        description: args.description
      });
      return JSON.stringify(entry);
    },
    finance_log_revenue: async (args) => {
      const entry = store.logRevenue({
        project: args.project,
        amount: args.amount,
        description: args.description,
        status: args.status
      });
      return JSON.stringify(entry);
    },
    finance_summary: async (args) => {
      const project = args.project;
      if (project) {
        return JSON.stringify(store.getProjectSummary(project));
      }
      const month = args.month;
      return JSON.stringify(store.getMonthlyPL(month));
    }
  };
}
export {
  createHandlers,
  manifest
};
