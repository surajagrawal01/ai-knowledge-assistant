// The safety gate between "the model asked" and "the database runs it".
// Pipeline, cheap checks first: exists? → allowed? → args valid? → run (time-limited) → result sane? → log.
// It NEVER throws: every outcome is a JSON object the model can read and act on.
import type { ToolCall } from "../../core/llm.js";
import { isToolError, toolError } from "./tools/common.js";
import type { ToolContext, ToolErrorCode, ToolRegistry, ToolResult } from "./tools/types.js";
import type { z } from "zod";

export type ToolExecution = {
    callId: string | null;
    name: string;
    args: unknown;              // as the model sent them (the trace shows what it asked for)
    result: ToolResult;         // shaped success OR a ToolError
    ok: boolean;
    errorCode: ToolErrorCode | null;
    ms: number;
};

export const TOOL_TIMEOUT_MS = 5_000;      // a stuck DB query must not hang the whole request
export const MAX_RESULT_CHARS = 8_000;     // a big result is resent on EVERY later step (B2): if hit, shaping is the bug

class ToolTimeoutError extends Error { }

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(`timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// "path: message" lines: the model fixes its call far more reliably from this than from raw issues.
export function formatIssues(issues: z.ZodError["issues"]): string {
    return issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

function maskEmail(email: string): string {
    const at = email.indexOf("@");
    return at > 0 ? `${email[0]}***${email.slice(at)}` : "***";
}

// Rule 44: log tool arguments, but never full customer PII. IDs stay readable.
export function redactArgs(args: unknown): unknown {
    if (!isPlainObject(args)) return args;
    const copy: Record<string, unknown> = { ...args };
    if (typeof copy.email === "string") copy.email = maskEmail(copy.email);
    if (typeof copy.phone === "string") copy.phone = `***${copy.phone.replace(/\D/g, "").slice(-2)}`;
    if (typeof copy.name === "string") copy.name = `${copy.name.trim().charAt(0)}***`;
    return copy;
}

// One JSON line per call. Never the result body: it contains customer data.
export function logToolCall(execution: ToolExecution, runId: string): void {
    console.log(
        JSON.stringify({
            module: "support-agent",
            runId,
            tool: execution.name,
            args: redactArgs(execution.args),
            ok: execution.ok,
            errorCode: execution.errorCode,
            ms: execution.ms,
        }),
    );
}

export type ExecuteOptions = { timeoutMs?: number };   // overridable so tests don't wait 5 s

export async function executeTool(
    call: ToolCall,
    tools: ToolRegistry,
    ctx: ToolContext,
    opts: ExecuteOptions = {},
): Promise<ToolExecution> {
    const started = Date.now();
    const result = await runChecked(call, tools, ctx, opts.timeoutMs ?? TOOL_TIMEOUT_MS);
    const failed = isToolError(result);
    const execution: ToolExecution = {
        callId: call.id,
        name: call.name,
        args: call.args,
        result,
        ok: !failed,
        errorCode: failed ? result.error : null,
        ms: Date.now() - started,
    };
    logToolCall(execution, ctx.runId);
    return execution;
}

async function runChecked(call: ToolCall, tools: ToolRegistry, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
    // ① Exists in THIS flow's registry? hasOwn, so "constructor" or "__proto__" can't sneak through.
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;
    if (tool === undefined) {
        return toolError("UNKNOWN_TOOL", `No tool named ${call.name}. Available: ${Object.keys(tools).join(", ")}`);
    }

    // ② Allowed? Defence in depth: no write tool is ever in a Mini 1 registry anyway.
    if (tool.kind === "write" && !ctx.writesApproved) {
        return toolError("NOT_ALLOWED", "This action requires human confirmation");
    }

    // ③ + ④ Validate, then run (inside invoke), with a time limit.
    let outcome;
    try {
        outcome = await withTimeout(tool.invoke(call.args, ctx), timeoutMs);
    } catch (err) {
        // The real error stays in the server log; the model gets something it can act on.
        console.error(`[tool] ${call.name} failed:`, err instanceof ToolTimeoutError ? err.message : err);
        return toolError(
            "TOOL_FAILED",
            `Temporary error while running ${call.name}. Continue without this data and say that it is missing.`,
        );
    }
    if (!outcome.ok) return toolError("INVALID_ARGS", formatIssues(outcome.issues));

    // ⑤ Result sane? A non-object or a huge result is a bug in the tool, not in the model.
    const result: unknown = outcome.result;
    if (!isPlainObject(result)) {
        console.error(`[tool] ${call.name} returned a non-object result`);
        return toolError("TOOL_FAILED", `Temporary error while running ${call.name}.`);
    }
    let size: number;
    try {
        size = JSON.stringify(result).length;
    } catch (err) {
        console.error(`[tool] ${call.name} returned a non-serialisable result:`, err);
        return toolError("TOOL_FAILED", `Temporary error while running ${call.name}.`);
    }
    if (size > MAX_RESULT_CHARS) {
        return toolError("RESULT_TOO_LARGE", `${call.name} returned too much data. Ask for less (e.g. a smaller limit).`);
    }
    return result;
}

// Several calls from ONE model turn. Results come back in the SAME order as `calls`:
// that's how toolResultsMessage pairs each result with its call.
export async function executeToolCalls(
    calls: ToolCall[],
    tools: ToolRegistry,
    ctx: ToolContext,
    opts: ExecuteOptions = {},
): Promise<ToolExecution[]> {
    // Reads are independent, so they run together. A write (never in Mini 1) runs one by one: order matters.
    const allReads = calls.every((c) => !Object.hasOwn(tools, c.name) || tools[c.name]?.kind === "read");
    if (allReads) return Promise.all(calls.map((c) => executeTool(c, tools, ctx, opts)));

    const executions: ToolExecution[] = [];
    for (const call of calls) executions.push(await executeTool(call, tools, ctx, opts));
    return executions;
}
