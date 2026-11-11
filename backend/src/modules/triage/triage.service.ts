//   ① extract (Part A) → ② gate → ③ brief → ④ investigate (B2's runAgent + submitTriage)
//   → ⑤ rules in code → ⑥ store the proposal → respond. A human confirms later (confirmTriage).
// Never throws for AI failures: every outcome is a suggestion a human can act on. Bugs still throw → 500.
import { prisma } from "../../core/prisma.js";
import {
    READ_TOOLS,
    newRunId,
    runAgent,
    userMessage,
    type AgentRunResult,
    type ToolContext,
} from "../support-agent/index.js";
import { extractTicket } from "../ticket-extractor/ticket-extractor.service.js";
import type { TicketExtraction } from "../ticket-extractor/ticket.schema.js";
import { createTicket as createTicketInDb, type NewTicket } from "./create-ticket.js";
import { getProposal, saveProposal } from "./proposal-store.js";
import { SUBMIT_TRIAGE } from "./submit-triage.tool.js";
import { buildBrief, TRIAGE_SYSTEM_PROMPT } from "./triage.prompt.js";
import { applyTriageRules, isConfirmable, type RuleFacts } from "./triage.rules.js";
import type { ConfirmResponse, TriageResponse, TriageSuggestion } from "./triage.schema.js";

// A normal triage is 3–5 steps; the last allowed step forces submitTriage.
export const TRIAGE_MAX_STEPS = 8;
export const TRIAGE_TIMEOUT_MS = 45_000;

export type TriageOptions = {
    now?: Date;                                   // evals pin the date
    generate?: Parameters<typeof runAgent>[0]["generate"];
};

function log(line: Record<string, unknown>): void {
    // Never message text or reply drafts: they contain customer data.
    console.log(JSON.stringify({ module: "triage", ...line }));
}

// When there's nothing trustworthy to suggest, a person takes over. Built by code, not the model.
function escalation(reason: string, extraction: TicketExtraction | null): TriageSuggestion {
    return {
        action: "escalate_to_human",
        customer_id: extraction?.customer_id ?? null,
        order_id: extraction?.order_id ?? null,
        verified: false,
        facts: [reason],
        proposed_ticket: null,
        existing_ticket_id: null,
        reply_draft: "Thank you for reaching out. A member of our support team will look into this and get back to you shortly.",
    };
}

// The DB's view of the IDs the model put in its suggestion (rule ①). Plain reads, no AI.
async function loadRuleFacts(s: TriageSuggestion, needsHuman: boolean): Promise<RuleFacts> {
    const [customer, order, ticket] = await Promise.all([
        s.customer_id === null ? undefined : prisma.customer.findUnique({ where: { id: s.customer_id }, select: { tier: true } }),
        s.order_id === null ? undefined : prisma.order.findUnique({ where: { id: s.order_id }, select: { customerId: true } }),
        s.existing_ticket_id === null
            ? undefined
            : prisma.ticket.findUnique({ where: { id: s.existing_ticket_id }, select: { customerId: true } }),
    ]);
    return {
        needsHuman,
        customer,
        orderOwner: order === undefined ? undefined : (order?.customerId ?? null),
        ticketOwner: ticket === undefined ? undefined : (ticket?.customerId ?? null),
    };
}

export async function triage(message: string, opts: TriageOptions = {}): Promise<TriageResponse> {
    const started = Date.now();
    const now = opts.now ?? new Date();

    // ① Extract: the clerk reads the message.
    const extraction = await extractTicket(message, now);

    // ② Gate: no extraction → no agent. A person reads it.
    if (!extraction.ok) {
        const suggestion = escalation(`The message couldn't be read automatically (${extraction.reason}).`, null);
        const proposal = saveProposal({ runId: null, suggestion, confirmable: false });
        log({ event: "triage", triageId: proposal.id, outcome: "extraction_failed", reason: extraction.reason, action: suggestion.action });
        return {
            triageId: proposal.id,
            outcome: "extraction_failed",
            extracted: null,
            extractionWarnings: [],
            suggestion,
            appliedRules: [`extraction failed (${extraction.reason}): escalate_to_human`],
            confirmable: false,
            trace: [],
            stats: {
                runId: null,
                extractionAttempts: extraction.attempts,
                modelCalls: 0,
                toolCalls: 0,
                ms: Date.now() - started,
                tokens: { input: 0, output: 0 },
            },
        };
    }
    const { ticket: extracted, warnings } = extraction;

    // ③ + ④ Brief the investigator, then let it check the facts.
    // ctx.customerId = the CLAIMED customer: ownership checks are ON, so "C002 here, O033?" learns
    // nothing about O033. No ID in the message (e.g. only an email) → null, the agent searches.
    const ctx: ToolContext = { runId: newRunId(), now, customerId: extracted.customer_id, writesApproved: false };
    const result: AgentRunResult<TriageSuggestion> = await runAgent({
        messages: [userMessage(buildBrief(message, extracted, warnings))],
        system: TRIAGE_SYSTEM_PROMPT,
        tools: READ_TOOLS,
        ctx,
        finish: SUBMIT_TRIAGE,
        maxSteps: TRIAGE_MAX_STEPS,
        timeoutMs: TRIAGE_TIMEOUT_MS,
        ...(opts.generate ? { generate: opts.generate } : {}),
    });

    const submitted = result.outcome === "submitted"
        ? result.submission
        : escalation(result.ok ? "The assistant finished without a suggestion." : result.reason, extracted);

    // ⑤ Rules: code has the final word.
    const { suggestion, appliedRules } = applyTriageRules(submitted, await loadRuleFacts(submitted, extracted.needs_human));
    if (result.outcome !== "submitted") appliedRules.unshift(`agent ${result.outcome}: escalate_to_human`);
    const confirmable = isConfirmable(suggestion);

    // ⑥ Store on the server, respond with the ID.
    const proposal = saveProposal({ runId: ctx.runId, suggestion, confirmable });
    const { run } = result;
    log({
        event: "triage",
        triageId: proposal.id,
        runId: ctx.runId,
        outcome: result.outcome,
        action: suggestion.action,
        verified: suggestion.verified,
        appliedRules: appliedRules.length,
        modelCalls: run.modelCalls,
        ms: Date.now() - started,
    });
    return {
        triageId: proposal.id,
        outcome: result.outcome,
        extracted,
        extractionWarnings: warnings,
        suggestion,
        appliedRules,
        confirmable,
        trace: run.steps,
        stats: {
            runId: run.runId,
            extractionAttempts: extraction.attempts,
            modelCalls: run.modelCalls,
            toolCalls: run.toolCalls,
            ms: Date.now() - started,
            tokens: { input: run.usage.inputTokens, output: run.usage.outputTokens },
        },
    };
}

// ── the human's decision ────────────────────────────────────────────────

export type ConfirmResult =
    | { ok: true; response: ConfirmResponse }
    | { ok: false; status: 404 | 409; error: string };

export type ConfirmDeps = { createTicket: (t: NewTicket) => Promise<{ id: string }> };   // tests pass a fake

// Idempotent: a double-click or a retried request returns the SAME ticket, never a second one.
export async function confirmTriage(triageId: string, deps: ConfirmDeps = { createTicket: createTicketInDb }): Promise<ConfirmResult> {
    const p = getProposal(triageId);
    if (p === null) return { ok: false, status: 404, error: "Unknown or expired triage" };
    if (p.status === "confirmed" && p.ticketId !== null) {
        return { ok: true, response: { ticketId: p.ticketId, alreadyConfirmed: true } };
    }
    if (p.status === "rejected") return { ok: false, status: 409, error: "This triage was rejected" };
    const ticket = p.suggestion.proposed_ticket;
    if (!p.confirmable || ticket === null || p.suggestion.customer_id === null) {
        return { ok: false, status: 409, error: `Nothing to create: the suggestion is ${p.suggestion.action}` };
    }

    // Two confirms at the same moment: the second awaits the first one's insert.
    if (p.confirming !== null) {
        const ticketId = await p.confirming;
        return { ok: true, response: { ticketId, alreadyConfirmed: true } };
    }
    const started = Date.now();
    p.confirming = deps
        .createTicket({ ...ticket, customerId: p.suggestion.customer_id, orderId: p.suggestion.order_id })
        .then((t) => t.id);
    try {
        const ticketId = await p.confirming;
        p.status = "confirmed";
        p.ticketId = ticketId;
        log({ event: "triage_confirmed", triageId, runId: p.runId, ticketId, msToDecide: started - p.createdAt });
        return { ok: true, response: { ticketId, alreadyConfirmed: false } };
    } finally {
        p.confirming = null;   // after a failure, a retry may try again
    }
}

export function rejectTriage(triageId: string): { ok: true } | { ok: false; status: 404 | 409; error: string } {
    const p = getProposal(triageId);
    if (p === null) return { ok: false, status: 404, error: "Unknown or expired triage" };
    if (p.status === "confirmed") return { ok: false, status: 409, error: `Already confirmed as ${p.ticketId}` };
    if (p.status === "pending") {
        p.status = "rejected";
        log({ event: "triage_rejected", triageId, runId: p.runId, action: p.suggestion.action, msToDecide: Date.now() - p.createdAt });
    }
    return { ok: true };   // rejecting twice is fine
}
