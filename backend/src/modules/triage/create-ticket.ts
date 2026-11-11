// The ONLY database write in Mini 1. Not a tool: no model can call it. Only the confirm endpoint
// does, after a human clicked Yes, with the server's own stored copy of the proposal.
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../core/prisma.js";
import { CustomerIdSchema, OrderIdSchema } from "../support-agent/index.js";
import { ProposedTicketSchema } from "./triage.schema.js";

// Validated again: never trust a proposal, not even our own store's copy.
export const NewTicketSchema = ProposedTicketSchema.extend({
    customerId: CustomerIdSchema,
    orderId: OrderIdSchema.nullable(),
});
export type NewTicket = z.infer<typeof NewTicketSchema>;

const MAX_ID_ATTEMPTS = 3;

// "T015" → 15. Parsed, not sorted as text: "T1000" < "T999" as strings.
export function ticketNumber(id: string): number {
    const match = /^T(\d+)$/.exec(id);
    return match ? Number(match[1]) : 0;
}

export function formatTicketId(n: number): string {
    return `T${String(n).padStart(3, "0")}`;
}

async function nextTicketId(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.ticket.findMany({ select: { id: true } });
    return formatTicketId(rows.reduce((max, r) => Math.max(max, ticketNumber(r.id)), 0) + 1);
}

function isUniqueConflict(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// "Highest + 1" inside a transaction. Two confirms at the same moment can still compute the same
// ID; the primary key rejects the second (P2002) and it retries with the next number.
// The foreign keys are the last safety net: a ticket for C999 or O777 can't exist.
export async function createTicket(input: NewTicket): Promise<{ id: string }> {
    const data = NewTicketSchema.parse(input);
    for (let attempt = 1; ; attempt++) {
        try {
            return await prisma.$transaction(async (tx) => {
                const id = await nextTicketId(tx);
                return tx.ticket.create({ data: { id, ...data, status: "open" }, select: { id: true } });
            });
        } catch (err) {
            if (!isUniqueConflict(err) || attempt >= MAX_ID_ATTEMPTS) throw err;
        }
    }
}
