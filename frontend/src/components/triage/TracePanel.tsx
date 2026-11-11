import type { TraceStep } from "@/lib/types";

// What the agent DID, step by step. Used by panel ② and by the follow-up chat.
// The args are already redacted by the backend (IDs readable, PII masked).
function formatArgs(args: unknown): string {
    if (typeof args !== "object" || args === null) return "";
    const values = Object.values(args).filter((v) => typeof v === "string" || typeof v === "number");
    return values.join(", ");
}

export function TraceList({ trace }: { trace: TraceStep[] }) {
    if (trace.length === 0) return <p className="text-sm text-neutral-500">No tools were called.</p>;
    return (
        <ol className="flex flex-col gap-2 text-sm">
            {trace.map((s, i) => {
                if (s.type === "tool_call") {
                    // The finish call carries the whole suggestion: show only its summary.
                    const args = s.tool === "submitTriage" ? "…" : formatArgs(s.args);
                    return (
                        <li key={i} className="flex gap-2">
                            <span className="w-6 shrink-0 text-right text-xs text-neutral-400">{s.step}</span>
                            <span className={s.ok ? "text-green-600" : "text-red-600"}>{s.ok ? "✓" : "✗"}</span>
                            <div className="min-w-0">
                                <div className="font-mono break-words">
                                    {s.tool}({args})
                                </div>
                                <div className="text-xs text-neutral-500 break-words">{s.summary}</div>
                            </div>
                        </li>
                    );
                }
                if (s.type === "guardrail") {
                    return (
                        <li key={i} className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                            <span className="w-6 shrink-0 text-right text-neutral-400">{s.step}</span>
                            <span>🛡 {s.kind}: {s.detail}</span>
                        </li>
                    );
                }
                if (s.final) return null;   // a chat's final answer is shown by the chat itself
                return (
                    <li key={i} className="flex gap-2 text-xs italic text-neutral-500">
                        <span className="w-6 shrink-0 text-right text-neutral-400">{s.step}</span>
                        <span className="break-words">“{s.text}”</span>
                    </li>
                );
            })}
        </ol>
    );
}

export function TraceStats({ modelCalls, ms, tokens }: { modelCalls: number; ms: number; tokens: { input: number; output: number } }) {
    return (
        <p className="text-xs text-neutral-500">
            {modelCalls} model call{modelCalls === 1 ? "" : "s"} · {(ms / 1000).toFixed(1)} s · {tokens.input + tokens.output} tokens
        </p>
    );
}
