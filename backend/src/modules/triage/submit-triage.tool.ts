// The finish tool: the agent ends a triage by calling it, and its ARGUMENTS are the result.
// It's never executed and never in the registry: runAgent validates the args and stops.
// createTicket is NOT a tool: a submitted "create_ticket" is only a proposal until a human confirms.
import type { FinishTool } from "../support-agent/index.js";
import { TriageSuggestionSchema, type TriageSuggestion } from "./triage.schema.js";

export const SUBMIT_TRIAGE: FinishTool<TriageSuggestion> = {
    name: "submitTriage",
    description:
        "Submit your triage conclusion. Call it exactly ONCE, on its own, after your checks: the run ends here. " +
        "Its arguments are your result: the action, the verified IDs, the facts you found, a proposed ticket " +
        "(create_ticket only) or an existing ticket ID (link_existing_ticket only), and a reply draft. " +
        "Nothing is created: a human reviews this suggestion.",
    schema: TriageSuggestionSchema,
    summarize: (s) =>
        s.proposed_ticket && s.action === "create_ticket"
            ? `${s.action} · ${s.proposed_ticket.category} · ${s.proposed_ticket.priority}`
            : s.existing_ticket_id
                ? `${s.action} · ${s.existing_ticket_id}`
                : s.action,
};
