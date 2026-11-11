"use client";

import { useState } from "react";
import type { TriageAction, TriageResponse } from "@/lib/types";
import { Panel } from "./Panel";

export type Decision =
    | { state: "pending" }
    | { state: "confirming" | "rejecting" }
    | { state: "confirmed"; ticketId: string; alreadyConfirmed: boolean }
    | { state: "rejected" }
    | { state: "error"; message: string };

const ACTION_LABELS: Record<TriageAction, { icon: string; label: string; tone: string }> = {
    create_ticket: { icon: "✅", label: "Create ticket", tone: "text-green-700 dark:text-green-400" },
    link_existing_ticket: { icon: "🔗", label: "Link existing ticket", tone: "text-blue-700 dark:text-blue-400" },
    ask_customer: { icon: "❓", label: "Ask the customer", tone: "text-amber-700 dark:text-amber-400" },
    reply_only: { icon: "💬", label: "Reply only, no ticket", tone: "text-neutral-700 dark:text-neutral-300" },
    escalate_to_human: { icon: "🚨", label: "Escalate to a human", tone: "text-red-700 dark:text-red-400" },
};

type Props = {
    result: TriageResponse;
    decision: Decision;
    onConfirm: () => void;
    onReject: () => void;
};

// Panel ③: what Part C suggests, AFTER the code rules. The human decides here.
export function SuggestionPanel({ result, decision, onConfirm, onReject }: Props) {
    const { suggestion: s, appliedRules, confirmable } = result;
    const action = ACTION_LABELS[s.action];
    const [copied, setCopied] = useState(false);
    // Disabled from the first click on: no double submit (the server is idempotent too).
    const decided = decision.state !== "pending" && decision.state !== "error";

    async function copyReply() {
        try {
            await navigator.clipboard.writeText(s.reply_draft);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard blocked (e.g. not https): the text is still selectable.
        }
    }

    return (
        <Panel step="③" title="Suggestion" part="Part C">
            <div className={`text-lg font-semibold ${action.tone}`}>
                {action.icon} {action.label}
            </div>

            {s.proposed_ticket && (
                <div className="rounded-md bg-neutral-100 p-3 text-sm dark:bg-neutral-900">
                    <div className="text-xs font-semibold uppercase">
                        {s.proposed_ticket.category} · {s.proposed_ticket.priority}
                    </div>
                    <div className="font-medium">{s.proposed_ticket.subject}</div>
                    <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{s.proposed_ticket.description}</div>
                </div>
            )}
            {s.existing_ticket_id && <div className="text-sm">Existing ticket: <span className="font-mono">{s.existing_ticket_id}</span></div>}

            <div className="text-sm">
                <span className="font-mono">{s.customer_id ?? "no customer"}</span>
                {s.order_id && <> · <span className="font-mono">{s.order_id}</span></>}
                {" · "}
                {s.verified ? <span className="text-green-600">Verified ✔</span> : <span className="text-amber-600">Not verified</span>}
            </div>

            {s.facts.length > 0 && (
                <div className="text-sm">
                    <div className="text-xs font-semibold uppercase text-neutral-500">Facts</div>
                    <ul className="list-disc pl-5">
                        {s.facts.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                </div>
            )}

            {appliedRules.length > 0 && (
                <div className="text-xs text-amber-700 dark:text-amber-400">
                    <div className="font-semibold uppercase">Changed by rules</div>
                    <ul>{appliedRules.map((r) => <li key={r}>⚙ {r}</li>)}</ul>
                </div>
            )}

            <div className="text-sm">
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-neutral-500">Reply draft</span>
                    <button type="button" onClick={copyReply} className="text-xs text-blue-600 hover:underline">
                        {copied ? "copied ✓" : "copy"}
                    </button>
                </div>
                <p className="mt-1 whitespace-pre-wrap rounded-md border border-neutral-200 p-2 dark:border-neutral-800">{s.reply_draft}</p>
            </div>

            {confirmable ? (
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={decided}
                        className="flex-1 rounded-md bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {decision.state === "confirming" ? "Creating…" : "Yes, create"}
                    </button>
                    <button
                        type="button"
                        onClick={onReject}
                        disabled={decided}
                        className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                        {decision.state === "rejecting" ? "…" : "No"}
                    </button>
                </div>
            ) : (
                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-neutral-500">Nothing to create: use the reply draft or hand it over.</p>
                    <button
                        type="button"
                        onClick={onReject}
                        disabled={decided}
                        className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                        Dismiss
                    </button>
                </div>
            )}
        </Panel>
    );
}
