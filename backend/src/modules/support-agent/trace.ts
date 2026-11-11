// What the agent DID, for humans and evals. Not the history:
//   history = for the model: complete, exact, provider-shaped, large. Never sent to the browser.
//   trace   = for people: short summaries, redacted args, timings. Never sent to the model.
import { randomUUID } from "node:crypto";
import type { Usage } from "../../core/llm.js";
import type { ToolExecution } from "./tool-executor.js";
import { isToolError } from "./tools/common.js";
import type { RegisteredTool } from "./tools/types.js";

export type GuardrailKind =
    | "max_steps"
    | "repeated_call"
    | "too_many_calls"
    | "timeout"
    | "tool_failure"
    | "empty_response"
    // Part C, finish tool only:
    | "invalid_submission"   // finish call with invalid args, or not alone: answered with INVALID_ARGS
    | "no_submission";       // text instead of the finish call

export type TraceStep =
    // Once per function call the model made, blocked ones included.
    | {
        type: "tool_call";
        step: number;
        tool: string;
        args: unknown;              // redacted (redactArgs): IDs readable, PII masked
        ok: boolean;
        errorCode: string | null;
        summary: string;
        ms: number;
    }
    // The final answer (final: true), or text the model wrote next to its tool calls (final: false).
    | { type: "model_text"; step: number; text: string; final: boolean }
    // Whenever a guard fires.
    | { type: "guardrail"; step: number; kind: GuardrailKind; detail: string };

export type AgentRun = {
    runId: string;               // joins the API response, the log lines and the trace
    steps: TraceStep[];
    modelCalls: number;          // the cost and latency driver
    toolCalls: number;           // blocked calls included
    usage: Usage;                // summed over every model call
    ms: number;
    finalHistorySize: number;    // characters in the history at the end: watch the context grow
};

// One ID to search the logs by when a support agent reports a bad answer.
export function newRunId(): string {
    return `run_${randomUUID().slice(0, 8)}`;
}

const MAX_SUMMARY_CHARS = 120;

function cut(text: string): string {
    return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

export function summarizeExecution(execution: ToolExecution, tool: RegisteredTool | undefined): string {
    if (!execution.ok) {
        const message = isToolError(execution.result) ? execution.result.message : "";
        return cut(`${execution.errorCode ?? "ERROR"}: ${message}`);
    }
    if (tool?.summarize) {
        // Display only: a broken summary must never break a run.
        try {
            return cut(tool.summarize(execution.result));
        } catch (err) {
            console.error(`[trace] summarize failed for ${execution.name}:`, err);
        }
    }
    return `ok (${Object.keys(execution.result).length} fields)`;
}
