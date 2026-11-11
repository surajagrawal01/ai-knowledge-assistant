// Public entry of the module. Evals and app.ts import from HERE only.
// Part C: A (extract) + B2 (runAgent) joined, rules in code, a human confirms the only write.
export { triage, confirmTriage, rejectTriage, TRIAGE_MAX_STEPS, type TriageOptions, type ConfirmResult } from "./triage.service.js";
export { applyTriageRules, isConfirmable, type RuleFacts, type RuleResult } from "./triage.rules.js";
export { buildBrief, TRIAGE_SYSTEM_PROMPT } from "./triage.prompt.js";
export { SUBMIT_TRIAGE } from "./submit-triage.tool.js";
export { saveProposal, getProposal, clearProposals, PROPOSAL_TTL_MS, type Proposal } from "./proposal-store.js";
export { createTicket, formatTicketId, ticketNumber, NewTicketSchema, type NewTicket } from "./create-ticket.js";
export {
    TRIAGE_ACTIONS,
    TriageSuggestionSchema,
    TriageRequestSchema,
    TriageIdSchema,
    type TriageAction,
    type TriageSuggestion,
    type TriageResponse,
    type TriageStats,
    type ConfirmResponse,
} from "./triage.schema.js";
export { triageRouter } from "./triage.routes.js";
