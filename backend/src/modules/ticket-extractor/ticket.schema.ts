import { z } from "zod";

// keep in sync with schema.prisma → TicketCategory / TicketPriority
export const TICKET_CATEGORIES = ["refund", "return", "replacement", "cancellation", "delivery", "warranty", "payment", "other"] as const;
export const TICKET_PRIORITIES = ["low", "medium", "high"] as const;


// Shared by the route (400 if longer) and the service (guard for non-HTTP callers like triage).
export const MAX_MESSAGE_LENGTH = 4000;

export const TicketExtractionSchema = z.object({
    issue_summary: z.string().min(5).max(200)
        .describe("One sentence in English: what went wrong and what the customer wants."),
    customer_id: z.string().regex(/^C\d{3}$/).nullable()
        .describe("Customer ID: C + 3 digits (e.g. C003). Only if written in the message, else null. Never guess."),
    customer_name: z.string().nullable()
        .describe("Customer's name if they state it, else null."),
    customer_email: z.string().nullable()
        .describe("Email address if written in the message, else null."),
    customer_phone: z.string().nullable()
        .describe("Phone number if written in the message, else null."),
    order_id: z.string().regex(/^O\d{3}$/).nullable()
        .describe("Order ID: O + 3 digits (e.g. O045). Only if written exactly in this format, else null. Never guess."),
    products_mentioned: z.array(z.string())
        .describe("Product names mentioned (e.g. ['NestBuds', 'charger']). Empty array if none."),
    category: z.enum(TICKET_CATEGORIES)
        .describe("What the customer wants. Use 'other' for questions, feedback or anything that fits nothing else."),
    priority: z.enum(TICKET_PRIORITIES)
        .describe("high = damaged on arrival, safety, money debited but order failed, legal threat, very angry. medium = refund/return/replacement/delay/warranty. low = question, feedback, thanks."),
    sentiment: z.enum(["positive", "neutral", "frustrated", "angry"]),
    needs_human: z.boolean()
        .describe("True for safety issues, legal threats, abuse, or messages too unclear to act on."),
});

// The ONLY TicketExtraction type: inferred, never hand-written (N3).
export type TicketExtraction = z.infer<typeof TicketExtractionSchema>;

// HTTP request body for POST /api/extract.
export const ExtractRequestSchema = z.object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

export type ExtractFailureReason = "api" | "not_json" | "schema" | "empty_input" | "too_long";

export type ExtractResult =
    | { ok: true; ticket: TicketExtraction; warnings: string[]; attempts: number }
    | { ok: false; reason: ExtractFailureReason; attempts: number; details?: unknown };
