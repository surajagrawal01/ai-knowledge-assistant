import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { CustomerIdSchema, daysAgo, toolError } from "./common.js";
import { defineTool } from "./types.js";

const MAX_TICKETS = 10;

// keep in sync with schema.prisma › enum TicketStatus
export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

const GetCustomerTicketsArgs = z.object({
  customerId: CustomerIdSchema,
  status: z.enum(TICKET_STATUSES).nullable().describe("Only tickets with this status; null = all statuses"),
});

export const getCustomerTickets = defineTool({
  name: "getCustomerTickets",
  description:
    "List a customer's existing support tickets, newest first (max 10): id, order, category, priority, status, " +
    "subject. Use to check whether the same issue was already reported before suggesting a new ticket. " +
    "Optionally filter by status.",
  args: GetCustomerTicketsArgs,
  kind: "read",
  async run({ customerId, status }, ctx) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (customer === null) return toolError("NOT_FOUND", `No customer with id ${customerId}`);

    const where = { customerId, ...(status !== null ? { status } : {}) };
    const [count, tickets] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: MAX_TICKETS,
        select: {
          id: true, orderId: true, category: true, priority: true, status: true, subject: true, createdAt: true,
        },
      }),
    ]);

    return {
      customerId,
      count,
      showing: tickets.length,
      tickets: tickets.map(({ createdAt, ...t }) => ({ ...t, createdDaysAgo: daysAgo(createdAt, ctx.now) })),
    };
  },
});
