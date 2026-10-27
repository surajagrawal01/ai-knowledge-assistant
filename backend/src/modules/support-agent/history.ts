// The only place that builds history messages, so the order rules live in one file.
// After a model turn with tool calls the history grows by EXACTLY two messages:
//   1. the assistant message, as returned (generateWithTools gives it to you ready-made)
//   2. ONE tool message with one result per call, same order, errors included
// The system prompt is never in the history (it's sent as systemInstruction on every call).
import type { ToolMessage, UserMessage } from "../../core/llm.js";
import type { ToolExecution } from "./tool-executor.js";

export function userMessage(text: string): UserMessage {
    const trimmed = text.trim();
    // A caller bug, not an AI failure: routes already return 400 for empty input.
    if (trimmed === "") throw new Error("userMessage: text is empty");
    return { role: "user", text: trimmed };
}

export function toolResultsMessage(executions: ToolExecution[]): ToolMessage {
    // An empty tool message would read as "nothing happened"; there must be a result for every call.
    if (executions.length === 0) throw new Error("toolResultsMessage: no executions");
    return {
        role: "tool",
        // Errors are results too: skipping a failed call leaves it unanswered.
        results: executions.map((e) => ({ callId: e.callId, name: e.name, result: e.result })),
    };
}
