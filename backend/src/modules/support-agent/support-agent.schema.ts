// The HTTP contract of POST /api/agent/chat. Requests are validated with Zod in the route;
// responses are plain types (our own code builds them).
import { z } from "zod";
import type { AgentOutcome } from "./agent-loop.js";
import type { TraceStep } from "./trace.js";

export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_MESSAGES = 20;
export const MAX_TOTAL_CHARS = 20_000;   // caps the cost of a single request

// Only the VISIBLE conversation crosses the API: no tool calls, tool results, raw turns or system prompt.
export const VisibleMessageSchema = z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});
export type VisibleMessage = z.infer<typeof VisibleMessageSchema>;


export const ChatRequestSchema = z
    .object({ messages: z.array(VisibleMessageSchema).min(1).max(MAX_MESSAGES) })
    .superRefine(({ messages }, ctx) => {
        // A malformed conversation gives confusing model behaviour: reject it at the door.
        messages.forEach((m, i) => {
            const expected = i % 2 === 0 ? "user" : "assistant";
            if (m.role !== expected) {
                ctx.addIssue({
                    code: "custom",
                    path: ["messages", i, "role"],
                    message: `expected "${expected}": roles must alternate, starting with user`,
                });
            }
        });
        if (messages.at(-1)?.role !== "user") {
            ctx.addIssue({ code: "custom", path: ["messages"], message: "the last message must be from the user" });
        }
        const total = messages.reduce((sum, m) => sum + m.text.length, 0);
        if (total > MAX_TOTAL_CHARS) {
            ctx.addIssue({ code: "custom", path: ["messages"], message: `total text is over ${MAX_TOTAL_CHARS} characters` });
        }
    });
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export type ChatStats = {
    runId: string;
    modelCalls: number;
    toolCalls: number;
    ms: number;
    tokens: { input: number; output: number };
};


export type ChatResponse = {
    ok: boolean;
    outcome: AgentOutcome;
    answer: string | null;
    reason?: string;
    trace: TraceStep[];
    stats: ChatStats;
};
