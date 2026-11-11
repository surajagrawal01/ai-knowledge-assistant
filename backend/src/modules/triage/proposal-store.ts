// Proposals live on the SERVER: the browser only says yes or no to an ID, so it can't edit the
// ticket in DevTools. Mini 1 trade-off: an in-memory Map, lost on restart and not shared between
// server instances. Mini 3 moves it to Redis or a DB table; the functions below stay the same.
import { randomUUID } from "node:crypto";
import type { TriageSuggestion } from "./triage.schema.js";

export const PROPOSAL_TTL_MS = 30 * 60_000;   // 30 minutes to decide
const MAX_PROPOSALS = 1_000;                   // a memory cap: the oldest go first

export type ProposalStatus = "pending" | "confirmed" | "rejected";

export type Proposal = {
    id: string;
    runId: string | null;
    suggestion: TriageSuggestion;   // after the rules: exactly what the human saw
    confirmable: boolean;
    status: ProposalStatus;
    ticketId: string | null;        // set once confirmed
    createdAt: number;
    // The confirm in progress: a second confirm awaits THIS instead of creating a second ticket.
    confirming: Promise<string> | null;
};

const proposals = new Map<string, Proposal>();

export function newTriageId(): string {
    return `tr_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function purgeExpired(now: number): void {
    for (const [id, p] of proposals) {
        // A Map iterates in insertion order: the first one still alive means the rest are too.
        if (now - p.createdAt < PROPOSAL_TTL_MS) break;
        proposals.delete(id);
    }
}

export function saveProposal(input: Pick<Proposal, "runId" | "suggestion" | "confirmable">, now = Date.now()): Proposal {
    purgeExpired(now);
    while (proposals.size >= MAX_PROPOSALS) {
        const oldest = proposals.keys().next().value;
        if (oldest === undefined) break;
        proposals.delete(oldest);
    }
    const proposal: Proposal = { ...input, id: newTriageId(), status: "pending", ticketId: null, createdAt: now, confirming: null };
    proposals.set(proposal.id, proposal);
    return proposal;
}

// null = unknown or expired: the route answers 404 either way.
export function getProposal(id: string, now = Date.now()): Proposal | null {
    purgeExpired(now);
    return proposals.get(id) ?? null;
}

// For the offline tests only.
export function clearProposals(): void {
    proposals.clear();
}
