// The triage contract: what the agent must submit (validated in the loop), the HTTP request,
// and the response. Requests and the suggestion are Zod; responses are plain types (our code builds them).
import { z } from "zod";
import { CustomerIdSchema, OrderIdSchema, type AgentOutcome, type TraceStep } from "../support-agent/index.js";
import {
    MAX_MESSAGE_LENGTH,
    TICKET_CATEGORIES,
    TICKET_PRIORITIES,
    type TicketExtraction,
} from "../ticket-extractor/ticket.schema.js";

export const TRIAGE_ACTIONS = [
    "create_ticket",          // a new ticket is needed: the human confirms it
    "link_existing_ticket",   // an open ticket already covers this issue
    "ask_customer",           // not enough verified information: ask for it
    "reply_only",             // the data answers it: no ticket needed
    "escalate_to_human",      // safety, legal, someone else's data, or anything unclear
] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const ProposedTicketSchema = z.object({
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(TICKET_PRIORITIES)
        .describe("high = damaged on arrival, safety, money debited but order failed. medium = delay, refund, return, warranty. low = questions."),
    subject: z.string().trim().min(5).max(120).describe("One line for the ticket list, e.g. 'O020 delayed: shipped 9 days ago'."),
    description: z.string().trim().min(10).max(1_000).describe("What happened and what was checked, for the support team. Facts from tools only."),
});
export type ProposedTicket = z.infer<typeof ProposedTicketSchema>;

// The finish tool's arguments. The refinements below are NOT in the JSON Schema the model sees,
// so the field descriptions say the same thing; the loop sends the Zod issues back if it slips.
// Nullable fields default to null: models often leave out an empty field instead of sending null.
export const TriageSuggestionSchema = z
    .object({
        action: z.enum(TRIAGE_ACTIONS),
        customer_id: CustomerIdSchema.nullable().default(null).describe("The VERIFIED customer ID (it was found by a tool), else null."),
        order_id: OrderIdSchema.nullable().default(null).describe("The VERIFIED order ID this is about (found by a tool and belongs to the customer), else null."),
        verified: z.boolean().describe("true only if the customer AND (when relevant) the order were confirmed by tool results."),
        facts: z.array(z.string().trim().min(1).max(200)).max(8)
            .describe("Short facts from tool results that support the action, e.g. 'O020 shipped 9 days ago, zone B, delayed by 2 days'."),
        proposed_ticket: ProposedTicketSchema.nullable().default(null).describe("Required when action is create_ticket, else null."),
        existing_ticket_id: z.string().trim().toUpperCase().regex(/^T\d{3}$/, "must look like T004").nullable().default(null)
            .describe("Required when action is link_existing_ticket: the open ticket's ID from getCustomerTickets, else null."),
        reply_draft: z.string().trim().min(1).max(1_500)
            .describe("A short, polite reply to the customer in their language style. No internal jargon, no promises of refunds."),
    })
    .superRefine((s, ctx) => {
        if (s.action === "create_ticket" && s.proposed_ticket === null) {
            ctx.addIssue({ code: "custom", path: ["proposed_ticket"], message: "required when action is create_ticket" });
        }
        if (s.action === "link_existing_ticket" && s.existing_ticket_id === null) {
            ctx.addIssue({ code: "custom", path: ["existing_ticket_id"], message: "required when action is link_existing_ticket" });
        }
    });
export type TriageSuggestion = z.infer<typeof TriageSuggestionSchema>;

// HTTP request body for POST /api/triage. Same limit as the extractor: triage calls it first.
export const TriageRequestSchema = z.object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

// "tr_" + 8 hex characters (see proposal-store.ts). Anything else is a 404 without a lookup.
export const TriageIdSchema = z.string().regex(/^tr_[0-9a-f]{8}$/);

export type TriageStats = {
    runId: string | null;        // null when the agent never ran (extraction failed)
    extractionAttempts: number;
    modelCalls: number;          // agent model calls (the extraction's are in extractionAttempts)
    toolCalls: number;
    ms: number;                  // the whole triage: extraction + agent + rules
    tokens: { input: number; output: number };
};

export type TriageResponse = {
    triageId: string;
    outcome: AgentOutcome | "extraction_failed";
    extracted: TicketExtraction | null;
    extractionWarnings: string[];
    suggestion: TriageSuggestion;   // AFTER the rules: what the human is asked to approve
    appliedRules: string[];         // what code changed, in order, e.g. "premium customer: priority medium → high"
    confirmable: boolean;           // true only for create_ticket: the only action with a write
    trace: TraceStep[];
    stats: TriageStats;
};

export type ConfirmResponse = { ticketId: string; alreadyConfirmed: boolean };
