// The agent loop: B1's one round (model → tools → results), repeated until the model answers
// or a limit is hit. The model DECIDES each next step; this file executes and controls.
//
//   for step = 1 .. maxSteps
//      deadline passed?            → timeout
//      model call                  → LlmApiError → llm_error
//      no tool calls?              → text: answered ✅ / no text: empty_response
//      push the model's turn (raw, unchanged)
//      guard the calls             → over the cap / repeated: answered with an error, NOT executed
//      execute the rest            (B1 executor, unchanged)
//      push ONE tool message       → a result for EVERY call, in call order
//      too many TOOL_FAILED?       → tool_failure
//   loop ended                     → max_steps
//
// It knows nothing about triage, prompts or specific tools: Part C reuses it with its own.
import {
    addUsage,
    generateWithTools,
    LlmApiError,
    ZERO_USAGE,
    type ChatMessage,
    type ToolCall,
    type Usage,
} from "../../core/llm.js";
import { historySize, toolResultsMessage } from "./history.js";
import { executeToolCalls, logToolCall, redactArgs, type ToolExecution } from "./tool-executor.js";
import { toolError } from "./tools/common.js";
import { toToolSpecs } from "./tools/index.js";
import type { ToolContext, ToolErrorCode, ToolRegistry } from "./tools/types.js";
import { summarizeExecution, type AgentRun, type GuardrailKind, type TraceStep } from "./trace.js";

export const DEFAULT_MAX_STEPS = 6;        // the longest normal run is ~4 steps; a little headroom
export const HARD_MAX_STEPS = 10;          // a caller can't ask for 100 paid model calls by mistake
export const DEFAULT_TIMEOUT_MS = 30_000;  // overall budget for one run
export const MAX_CALLS_PER_STEP = 5;       // stops a "fetch everything" fan-out in a single step
export const MAX_INFRA_FAILURES = 3;       // 3 TOOL_FAILED in one run: the DB is probably down, stop paying

export type AgentOutcome = "answered" | "max_steps" | "timeout" | "tool_failure" | "llm_error" | "empty_response";
export type AgentFailure = Exclude<AgentOutcome, "answered">;

export type RunAgentInput = {
    messages: ChatMessage[];     // the starting history; must end with a user message
    system: string;              // support chat now, triage in Part C
    tools: ToolRegistry;         // the allow-list for THIS run
    ctx: ToolContext;
    maxSteps?: number;           // clamped to 1..HARD_MAX_STEPS
    timeoutMs?: number;
    generate?: typeof generateWithTools;   // overridable so offline tests can script the model (no API call)
};

export type AgentRunResult =
    | { ok: true; outcome: "answered"; answer: string; run: AgentRun; messages: ChatMessage[] }
    | { ok: false; outcome: AgentFailure; reason: string; answer: null; run: AgentRun; messages: ChatMessage[] };

// Short and safe to show in the UI. The details are in the trace and the server log.
const FAILURE_REASONS: Readonly<Record<AgentFailure, string>> = {
    max_steps: "The assistant needed more steps than allowed. See what it checked below.",
    timeout: "The assistant took too long. See what it checked below.",
    tool_failure: "Some data couldn't be loaded right now. Please try again.",
    llm_error: "The AI service is unavailable right now. Please try again.",
    empty_response: "The assistant returned no answer.",
};

// ── guards ──────────────────────────────────────────────────────────────

// JSON with object keys sorted, recursively: {"a":1,"b":2} and {"b":2,"a":1} are the same call.
// Exported for the offline tests.
export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        const entries: [string, unknown][] = Object.entries(value);
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";   // undefined has no JSON form
}

// Keyed on the RAW args: "c999" and "C999" differ, so that pair runs twice. Harmless: same NOT_FOUND.
export function callKey(call: ToolCall): string {
    return `${call.name}:${stableStringify(call.args)}`;
}

export type GuardDecision =
    | { call: ToolCall; blocked: null }
    | { call: ToolCall; blocked: ToolExecution; guard: GuardrailKind };

function blockedExecution(call: ToolCall, code: ToolErrorCode, message: string): ToolExecution {
    // Same shape as a real result, so it flows through the same history and trace code.
    return { callId: call.id, name: call.name, args: call.args, result: toolError(code, message), ok: false, errorCode: code, ms: 0 };
}

// One decision per call, in CALL order. A blocked call still gets a result: a model turn with
// N calls must be followed by N results, or the history is broken. `seen` lives for the whole run.
// Exported for the offline tests.
export function guardCalls(calls: ToolCall[], seen: Set<string>): GuardDecision[] {
    return calls.map((call, position): GuardDecision => {
        if (position >= MAX_CALLS_PER_STEP) {
            // Not added to `seen`: the model may ask for it again next step.
            const message = `Too many tool calls in one step (max ${MAX_CALLS_PER_STEP}). Ask for the rest in your next step.`;
            return { call, blocked: blockedExecution(call, "TOO_MANY_CALLS", message), guard: "too_many_calls" };
        }
        const key = callKey(call);
        if (seen.has(key)) {
            // The prompt says "don't retry"; this makes sure.
            const message =
                `You already called ${call.name} with these exact arguments in this conversation. ` +
                "Use that result or try a different approach.";
            return { call, blocked: blockedExecution(call, "REPEATED_CALL", message), guard: "repeated_call" };
        }
        seen.add(key);
        return { call, blocked: null };
    });
}

// ── the loop ────────────────────────────────────────────────────────────

type RunState = {
    runId: string;
    started: number;
    step: number;
    messages: ChatMessage[];
    trace: TraceStep[];
    modelCalls: number;
    toolCalls: number;
    usage: Usage;
};

function guardrail(state: RunState, kind: GuardrailKind, detail: string): void {
    state.trace.push({ type: "guardrail", step: state.step, kind, detail });
}

// Six exits, ONE builder: no exit can forget the trace or the run log.
function finish(state: RunState, end: { outcome: "answered"; answer: string } | { outcome: AgentFailure }): AgentRunResult {
    const run: AgentRun = {
        runId: state.runId,
        steps: state.trace,
        modelCalls: state.modelCalls,
        toolCalls: state.toolCalls,
        usage: state.usage,
        ms: Date.now() - state.started,
        finalHistorySize: historySize(state.messages),
    };
    // One line per run. Never message text: it contains customer data.
    console.log(
        JSON.stringify({
            module: "support-agent",
            event: "run",
            runId: run.runId,
            outcome: end.outcome,
            steps: state.step,
            modelCalls: run.modelCalls,
            toolCalls: run.toolCalls,
            tokensIn: run.usage.inputTokens,
            tokensOut: run.usage.outputTokens,
            historyChars: run.finalHistorySize,
            ms: run.ms,
        }),
    );
    if (end.outcome === "answered") {
        return { ok: true, outcome: "answered", answer: end.answer, run, messages: state.messages };
    }
    return { ok: false, outcome: end.outcome, reason: FAILURE_REASONS[end.outcome], answer: null, run, messages: state.messages };
}

export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
    // Caller bugs, not AI failures: the route already guarantees both.
    if (input.messages.at(-1)?.role !== "user") throw new Error("runAgent: messages must end with a user message");
    if (Object.keys(input.tools).length === 0) throw new Error("runAgent: no tools (use generateText for a plain chatbot)");

    const maxSteps = Math.min(Math.max(Math.floor(input.maxSteps ?? DEFAULT_MAX_STEPS), 1), HARD_MAX_STEPS);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const generate = input.generate ?? generateWithTools;
    const toolSpecs = toToolSpecs(input.tools);   // built once, sent on every model call

    const state: RunState = {
        runId: input.ctx.runId,
        started: Date.now(),
        step: 0,
        messages: [...input.messages],   // a copy: never mutate the caller's array
        trace: [],
        modelCalls: 0,
        toolCalls: 0,
        usage: ZERO_USAGE,
    };
    const deadline = state.started + timeoutMs;
    const seenCalls = new Set<string>();
    let infraFailures = 0;

    for (let step = 1; step <= maxSteps; step++) {
        state.step = step;

        // 1. Deadline, checked before each (paid, slow) model call.
        if (Date.now() >= deadline) {
            guardrail(state, "timeout", `${timeoutMs} ms budget used up before model call ${step}`);
            return finish(state, { outcome: "timeout" });
        }

        // 2. The model decides: answer, or which tools to call next.
        let res;
        try {
            res = await generate({ system: input.system, messages: state.messages, tools: toolSpecs });
        } catch (err) {
            if (!(err instanceof LlmApiError)) throw err;   // anything else is a bug → 500
            console.error(`[agent] ${state.runId} model call ${step} failed:`, err.message);
            return finish(state, { outcome: "llm_error" });
        }
        state.modelCalls++;
        state.usage = addUsage(state.usage, res.usage);

        // 3. No tool calls = the stop signal.
        if (res.toolCalls.length === 0) {
            if (res.text === null) {
                guardrail(state, "empty_response", `no text and no tool calls (finishReason: ${res.finishReason ?? "none"})`);
                return finish(state, { outcome: "empty_response" });
            }
            state.messages.push(res.assistantMessage);
            state.trace.push({ type: "model_text", step, text: res.text, final: true });
            return finish(state, { outcome: "answered", answer: res.text });
        }

        // 4. The model's turn FIRST, unchanged (raw keeps the thought signatures).
        //    Results pushed before it would answer questions the model never asked.
        state.messages.push(res.assistantMessage);
        if (res.text !== null) state.trace.push({ type: "model_text", step, text: res.text, final: false });

        // 5. Guard, then execute only what passed.
        const decisions = guardCalls(res.toolCalls, seenCalls);
        const toRun = decisions.flatMap((d) => (d.blocked === null ? [d.call] : []));
        const executed = toRun.length > 0 ? await executeToolCalls(toRun, input.tools, input.ctx) : [];

        // 6. Merge back into CALL order: executed results come back in toRun's order.
        let next = 0;
        const executions = decisions.map((d): ToolExecution => {
            if (d.blocked !== null) return d.blocked;
            const execution = executed[next++];
            if (execution === undefined) throw new Error("runAgent: the executor returned fewer results than calls");
            return execution;
        });

        // 7. ONE tool message: a result for every call, same order, errors and blocked calls included.
        state.messages.push(toolResultsMessage(executions));

        // 8. Trace (+ a log line for blocked calls: the executor already logged the real ones).
        decisions.forEach((d, i) => {
            const execution = executions[i];
            if (execution === undefined) return;
            if (d.blocked !== null) logToolCall(execution, state.runId);
            const tool = Object.hasOwn(input.tools, execution.name) ? input.tools[execution.name] : undefined;
            state.trace.push({
                type: "tool_call",
                step,
                tool: execution.name,
                args: redactArgs(execution.args),
                ok: execution.ok,
                errorCode: execution.errorCode,
                summary: summarizeExecution(execution, tool),
                ms: execution.ms,
            });
            if (d.blocked !== null) guardrail(state, d.guard, `${execution.name}: ${execution.errorCode}, not executed`);
        });
        state.toolCalls += executions.length;

        // 9. One TOOL_FAILED goes to the model (it can say what's missing). Several = infrastructure down.
        infraFailures += executions.filter((e) => e.errorCode === "TOOL_FAILED").length;
        if (infraFailures >= MAX_INFRA_FAILURES) {
            guardrail(state, "tool_failure", `${infraFailures} TOOL_FAILED results in this run`);
            return finish(state, { outcome: "tool_failure" });
        }
    }

    guardrail(state, "max_steps", `no answer after ${maxSteps} model calls`);
    return finish(state, { outcome: "max_steps" });
}
