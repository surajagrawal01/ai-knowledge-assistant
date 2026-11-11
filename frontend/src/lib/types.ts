// Copied from the backend (the frontend only talks HTTP, it never imports backend code).
// Keep in sync with:
//   backend/src/modules/ticket-extractor/ticket.schema.ts   → TicketExtraction
//   backend/src/modules/support-agent/trace.ts               → TraceStep
//   backend/src/modules/support-agent/support-agent.schema.ts → ChatResponse
//   backend/src/modules/triage/triage.schema.ts               → TriageResponse, ConfirmResponse

export type TicketCategory = "refund" | "return" | "replacement" | "cancellation" | "delivery" | "warranty" | "payment" | "other";
export type TicketPriority = "low" | "medium" | "high";

export type TicketExtraction = {
    issue_summary: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    order_id: string | null;
    products_mentioned: string[];
    category: TicketCategory;
    priority: TicketPriority;
    sentiment: "positive" | "neutral" | "frustrated" | "angry";
    needs_human: boolean;
};

export type TraceStep =
    | { type: "tool_call"; step: number; tool: string; args: unknown; ok: boolean; errorCode: string | null; summary: string; ms: number }
    | { type: "model_text"; step: number; text: string; final: boolean }
    | { type: "guardrail"; step: number; kind: string; detail: string };

export type AgentOutcome =
    | "answered" | "submitted"
    | "max_steps" | "timeout" | "tool_failure" | "llm_error" | "empty_response" | "no_submission";

export type TriageAction = "create_ticket" | "link_existing_ticket" | "ask_customer" | "reply_only" | "escalate_to_human";

export type TriageSuggestion = {
    action: TriageAction;
    customer_id: string | null;
    order_id: string | null;
    verified: boolean;
    facts: string[];
    proposed_ticket: { category: TicketCategory; priority: TicketPriority; subject: string; description: string } | null;
    existing_ticket_id: string | null;
    reply_draft: string;
};

export type TriageResponse = {
    triageId: string;
    outcome: AgentOutcome | "extraction_failed";
    extracted: TicketExtraction | null;
    extractionWarnings: string[];
    suggestion: TriageSuggestion;
    appliedRules: string[];
    confirmable: boolean;
    trace: TraceStep[];
    stats: {
        runId: string | null;
        extractionAttempts: number;
        modelCalls: number;
        toolCalls: number;
        ms: number;
        tokens: { input: number; output: number };
    };
};

export type ConfirmResponse = { ticketId: string; alreadyConfirmed: boolean };

export type VisibleMessage = { role: "user" | "assistant"; text: string };

export type ChatResponse = {
    ok: boolean;
    outcome: AgentOutcome;
    answer: string | null;
    reason?: string;
    trace: TraceStep[];
    stats: { runId: string; modelCalls: number; toolCalls: number; ms: number; tokens: { input: number; output: number } };
};
