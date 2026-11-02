import { runAgent, type AgentRunResult } from "./agent-loop.js";
import { fromVisibleChat } from "./history.js";
import type { ChatResponse, VisibleMessage } from "./support-agent.schema.js";
import { AGENT_SYSTEM_PROMPT } from "./support-agent.prompt.js";
import { READ_TOOLS } from "./tools/index.js";
import type { ToolContext } from "./tools/types.js";
import { newRunId } from "./trace.js";

export type ChatOptions = { now?: Date };   // evals pin the date


export async function chat(messages: VisibleMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    // ctx is born HERE, on the server: the model can't see or change it.
    // customerId: null = for internal staff purposes, may look up any customer (triage sets a real one in Part C).
    const ctx: ToolContext = { runId: newRunId(), now: opts.now ?? new Date(), customerId: null, writesApproved: false };
    const result = await runAgent({
        messages: fromVisibleChat(messages),
        system: AGENT_SYSTEM_PROMPT,
        tools: READ_TOOLS,
        ctx,
    });
    return toChatResponse(result);
}

// Drops `messages` (the full history): it holds raw model turns and full tool results.
// The browser needs only the answer and the trace.
function toChatResponse(result: AgentRunResult): ChatResponse {
    const { run } = result;
    return {
        ok: result.ok,
        outcome: result.outcome,
        answer: result.answer,
        ...(result.ok ? {} : { reason: result.reason }),
        trace: run.steps,
        stats: {
            runId: run.runId,
            modelCalls: run.modelCalls,
            toolCalls: run.toolCalls,
            ms: run.ms,
            tokens: { input: run.usage.inputTokens, output: run.usage.outputTokens },
        },
    };
}
