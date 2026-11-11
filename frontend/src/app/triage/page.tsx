// frontend/src/app/triage/page.tsx: the Mini 1 desk.
// Paste → ① what Part A read · ② what Part B checked · ③ what Part C suggests → a human says yes or no.
// The page only talks HTTP to the backend: no AI and no database here.
"use client";

import { useState } from "react";
import { ExtractionPanel } from "@/components/triage/ExtractionPanel";
import { FollowUpChat } from "@/components/triage/FollowUpChat";
import { MessageInput } from "@/components/triage/MessageInput";
import { Panel } from "@/components/triage/Panel";
import { SuggestionPanel, type Decision } from "@/components/triage/SuggestionPanel";
import { TraceList, TraceStats } from "@/components/triage/TracePanel";
import { apiPost } from "@/lib/api";
import type { ConfirmResponse, TriageResponse } from "@/lib/types";

type Status =
    | { state: "idle" }
    | { state: "loading" }
    | { state: "result"; result: TriageResponse }
    | { state: "error"; message: string };

const OUTCOME_NOTES: Partial<Record<TriageResponse["outcome"], string>> = {
    llm_error: "The AI service failed mid-way (often the free-tier rate limit). The suggestion fell back to a human.",
    timeout: "The agent ran out of time. The suggestion fell back to a human.",
    max_steps: "The agent needed more steps than allowed. The suggestion fell back to a human.",
    tool_failure: "Some data couldn't be loaded. The suggestion fell back to a human.",
    no_submission: "The agent didn't produce a suggestion. It fell back to a human.",
    extraction_failed: "The message couldn't be read automatically. It fell back to a human.",
};

function errorMessage(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    // apiPost puts the JSON body in the message: show the backend's own error when there is one.
    const match = /"error":"([^"]+)"/.exec(text);
    return match?.[1] ?? text;
}

export default function TriagePage() {
    const [message, setMessage] = useState("");
    const [status, setStatus] = useState<Status>({ state: "idle" });
    const [decision, setDecision] = useState<Decision>({ state: "pending" });

    async function runTriage() {
        setStatus({ state: "loading" });
        setDecision({ state: "pending" });
        try {
            const result = await apiPost<TriageResponse>("/api/triage", { message });
            setStatus({ state: "result", result });
        } catch (err) {
            setStatus({ state: "error", message: errorMessage(err) });
        }
    }

    async function decide(kind: "confirm" | "reject") {
        if (status.state !== "result") return;
        const { triageId } = status.result;
        setDecision({ state: kind === "confirm" ? "confirming" : "rejecting" });   // disables both buttons at once
        try {
            if (kind === "confirm") {
                const res = await apiPost<ConfirmResponse>(`/api/triage/${triageId}/confirm`, {});
                setDecision({ state: "confirmed", ticketId: res.ticketId, alreadyConfirmed: res.alreadyConfirmed });
            } else {
                await apiPost<{ ok: true }>(`/api/triage/${triageId}/reject`, {});
                setDecision({ state: "rejected" });
            }
        } catch (err) {
            setDecision({ state: "error", message: errorMessage(err) });
        }
    }

    const result = status.state === "result" ? status.result : null;
    const note = result ? OUTCOME_NOTES[result.outcome] : undefined;

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
            <header>
                <h1 className="text-xl font-bold">ElectroNest · Ticket Triage</h1>
                <p className="text-sm text-neutral-500">A reads · B checks · C suggests · you approve</p>
            </header>

            <MessageInput value={message} onChange={setMessage} onSubmit={runTriage} busy={status.state === "loading"} />

            {status.state === "loading" && (
                <p className="animate-pulse text-sm text-neutral-500">Investigating… reading the message, then checking the database (usually 3–10 s).</p>
            )}
            {status.state === "error" && (
                <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                    {status.message}
                </p>
            )}

            {result && (
                <>
                    {note && (
                        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                            {note}
                        </p>
                    )}
                    <div className="grid gap-4 lg:grid-cols-3">
                        <ExtractionPanel extracted={result.extracted} warnings={result.extractionWarnings} />
                        <Panel step="②" title="Checked" part="Part B">
                            <TraceList trace={result.trace} />
                            <TraceStats modelCalls={result.stats.modelCalls} ms={result.stats.ms} tokens={result.stats.tokens} />
                        </Panel>
                        <SuggestionPanel
                            result={result}
                            decision={decision}
                            onConfirm={() => void decide("confirm")}
                            onReject={() => void decide("reject")}
                        />
                    </div>

                    {decision.state === "confirmed" && (
                        <p className="rounded-md border border-green-300 bg-green-50 p-3 text-sm font-semibold text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300">
                            ✔ Ticket {decision.ticketId} {decision.alreadyConfirmed ? "was already created" : "created"}
                        </p>
                    )}
                    {decision.state === "rejected" && (
                        <p className="rounded-md border border-neutral-300 p-3 text-sm text-neutral-600 dark:border-neutral-700">
                            Rejected: nothing was created.
                        </p>
                    )}
                    {decision.state === "error" && <p className="text-sm text-red-600">{decision.message}</p>}
                </>
            )}

            <FollowUpChat />
        </main>
    );
}
