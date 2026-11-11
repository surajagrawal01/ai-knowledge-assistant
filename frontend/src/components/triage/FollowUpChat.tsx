"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import type { ChatResponse, TraceStep, VisibleMessage } from "@/lib/types";
import { TraceList, TraceStats } from "./TracePanel";

const MAX_MESSAGES = 20;   // same as the backend's support-agent.schema.ts

// A follow-up question to the B2 agent (POST /api/agent/chat). Only the VISIBLE conversation is
// sent back each time: the backend rebuilds the history from it.
export function FollowUpChat() {
    const [messages, setMessages] = useState<VisibleMessage[]>([]);
    const [draft, setDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [last, setLast] = useState<{ trace: TraceStep[]; stats: ChatResponse["stats"] } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const full = messages.length >= MAX_MESSAGES - 1;

    async function send() {
        const text = draft.trim();
        if (text === "" || busy || full) return;
        const next: VisibleMessage[] = [...messages, { role: "user", text }];
        setMessages(next);
        setDraft("");
        setBusy(true);
        setError(null);
        try {
            const res = await apiPost<ChatResponse>("/api/agent/chat", { messages: next });
            const answer = res.answer ?? res.reason ?? "No answer.";
            setMessages([...next, { role: "assistant", text: answer }]);
            setLast({ trace: res.trace, stats: res.stats });
        } catch (err) {
            // Roll back the question so the roles keep alternating.
            setMessages(messages);
            setDraft(text);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <header className="flex items-baseline justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide">Ask a follow-up</h2>
                <span className="text-xs text-neutral-500">Part B · /api/agent/chat</span>
            </header>

            {messages.length > 0 && (
                <ul className="flex flex-col gap-2 text-sm">
                    {messages.map((m, i) => (
                        <li
                            key={i}
                            className={`max-w-[85%] whitespace-pre-wrap rounded-md px-3 py-2 ${m.role === "user" ? "self-end bg-blue-600 text-white" : "self-start bg-neutral-100 dark:bg-neutral-900"
                                }`}
                        >
                            {m.text}
                        </li>
                    ))}
                </ul>
            )}

            <form
                className="flex gap-2"
                onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                }}
            >
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={2000}
                    disabled={busy || full}
                    placeholder={full ? "Conversation is full: reload to start over" : "e.g. Does C002 have other orders?"}
                    className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700"
                />
                <button
                    type="submit"
                    disabled={busy || full || draft.trim() === ""}
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                    {busy ? "…" : "Send"}
                </button>
            </form>
            {error && <p className="text-sm text-red-600">{error}</p>}

            {last && (
                <details className="text-sm">
                    <summary className="cursor-pointer text-xs text-neutral-500">What the agent checked for the last answer</summary>
                    <div className="mt-2 flex flex-col gap-2">
                        <TraceList trace={last.trace} />
                        <TraceStats modelCalls={last.stats.modelCalls} ms={last.stats.ms} tokens={last.stats.tokens} />
                    </div>
                </details>
            )}
        </section>
    );
}
