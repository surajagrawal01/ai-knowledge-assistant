// Code has the final word. The model SUGGESTS; these plain `if`s decide what a human is asked to
// approve, so no message can talk its way past them. Pure: the service loads the facts from the DB,
// so every rule is tested offline (evals/triage/rules.test.ts).
//
//   ① IDs re-checked against the DB   customer missing / order not found → unverified
//                                    order or ticket of ANOTHER customer → escalate_to_human
//   ② create_ticket but not verified → ask_customer
//   ③ needs_human (extraction)        → escalate_to_human, always
//   ④ premium customer + a ticket     → priority one level up
//
// "create_ticket without proposed_ticket" can't reach here: the schema rejects it inside the loop.
import type { TicketExtraction } from "../ticket-extractor/ticket.schema.js";
import type { TriageAction, TriageSuggestion } from "./triage.schema.js";

// What the DB says about the IDs in the suggestion. `undefined` = the suggestion has no such ID;
// `null` = it has one, and the DB has no row for it.
export type RuleFacts = {
    needsHuman: boolean;
    customer: { tier: "regular" | "premium" } | null | undefined;
    orderOwner: string | null | undefined;     // the order's customerId
    ticketOwner: string | null | undefined;    // the existing ticket's customerId
};

export type RuleResult = { suggestion: TriageSuggestion; appliedRules: string[] };

const NEXT_PRIORITY = { low: "medium", medium: "high", high: "high" } as const satisfies Record<
    TicketExtraction["priority"],
    TicketExtraction["priority"]
>;

export function applyTriageRules(input: TriageSuggestion, facts: RuleFacts): RuleResult {
    // A copy: the agent's original stays as it was (the trace shows what the model submitted).
    const s: TriageSuggestion = {
        ...input,
        facts: [...input.facts],
        proposed_ticket: input.proposed_ticket ? { ...input.proposed_ticket } : null,
    };
    const applied: string[] = [];
    const setAction = (action: TriageAction, why: string) => {
        if (s.action === action) return;
        applied.push(`${why}: ${s.action} → ${action}`);
        s.action = action;
    };
    const unverify = (why: string) => {
        if (s.verified) applied.push(`${why}: verified → false`);
        s.verified = false;
    };

    // ① The model's "verified" is a claim; the DB is the truth.
    if (s.customer_id === null) unverify("no customer identified");
    else if (facts.customer === null) unverify(`customer ${s.customer_id} not found`);
    if (s.order_id !== null && facts.orderOwner === null) unverify(`order ${s.order_id} not found`);
    if (s.order_id !== null && s.customer_id !== null && typeof facts.orderOwner === "string" && facts.orderOwner !== s.customer_id) {
        unverify(`order ${s.order_id} belongs to another customer`);
        setAction("escalate_to_human", `order ${s.order_id} belongs to another customer`);
    }
    if (s.existing_ticket_id !== null && facts.ticketOwner !== undefined && facts.ticketOwner !== s.customer_id) {
        const why = facts.ticketOwner === null
            ? `ticket ${s.existing_ticket_id} not found`
            : `ticket ${s.existing_ticket_id} belongs to another customer`;
        s.existing_ticket_id = null;
        setAction("escalate_to_human", why);
    }

    // ② Never ask a human to create a ticket for an unverified customer or order.
    if (s.action === "create_ticket" && !s.verified) setAction("ask_customer", "not verified");

    // ③ Safety and legal always go to a person, whatever the model concluded.
    if (facts.needsHuman) setAction("escalate_to_human", "needs_human from extraction");

    // ④ Premium customers get one priority level more.
    if (s.proposed_ticket && facts.customer?.tier === "premium") {
        const from = s.proposed_ticket.priority;
        const to = NEXT_PRIORITY[from];
        if (to !== from) {
            s.proposed_ticket.priority = to;
            applied.push(`premium customer: priority ${from} → ${to}`);
        }
    }

    return { suggestion: s, appliedRules: applied };
}

// Only create_ticket writes anything, and only with a ticket to write.
export function isConfirmable(s: TriageSuggestion): boolean {
    return s.action === "create_ticket" && s.proposed_ticket !== null && s.verified && s.customer_id !== null;
}
