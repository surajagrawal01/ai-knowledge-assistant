// The ONLY file that imports the Gemini SDK.
// Modules call the functions below; they never import "@google/genai".
// This file only translates ONE call to Gemini and back (+ API-level retries).
import { ApiError, Content, FunctionCallingConfigMode, GoogleGenAI, Part, Tool } from "@google/genai";
import { env } from "./env.js";
import { isFiniteVector, normalize, Vector } from "./vector.js";

export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
export const MODEL = env.GEMINI_MODEL;
export const EMBEDDING_MODEL = env.EMBEDDING_MODEL;

// Provider-neutral shapes: no Gemini names leak out of this file.
export type Usage = { inputTokens: number; outputTokens: number };

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
    return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

// Thrown when the provider itself failed (network, timeout, 429, 5xx, 4xx).
// Callers catch THIS class only; any other error is a bug and should reach the 500 handler.
export class LlmApiError extends Error {
    constructor(
        message: string,
        readonly status: number | null,   // null = no HTTP response (network error / timeout)
        readonly retryable: boolean,
    ) {
        super(message);
        this.name = "LlmApiError";
    }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 3_000];   // wait before attempt 2, attempt 3

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toLlmApiError(err: unknown): LlmApiError {
    if (err instanceof ApiError) {
        // 429 = rate limit, 5xx = Google's side: worth retrying.
        // Other 4xx (bad key, bad schema, unknown model) will fail the same way again.
        const retryable = err.status === 429 || err.status >= 500;
        return new LlmApiError(`Gemini API error ${err.status}: ${err.message}`, err.status, retryable);
    }
    // No HTTP status: fetch failed, DNS, connection reset, or our timeout aborted it.
    const message = err instanceof Error ? err.message : String(err);
    return new LlmApiError(`Gemini request failed: ${message}`, null, true);
}

//every loop has a limit. Max 3 attempts, then the error goes up.
async function callWithApiRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await call();
        } catch (err) {
            const apiError = toLlmApiError(err);
            if (!apiError.retryable || attempt >= MAX_API_ATTEMPTS) throw apiError;
            const wait = BACKOFF_MS[attempt - 1] ?? 3_000;
            console.warn(`[llm] attempt ${attempt} failed (${apiError.status ?? "network"}), retrying in ${wait}ms`);
            await sleep(wait);
        }
    }
}

// ── Step 0 ─────────────────────────────────────────────────────────────

export type GenerateTextInput = {
    system?: string;        // the model's "job description"
    prompt: string;         // the user input
    temperature?: number;   // defaults to 0
};

export async function generateText(input: GenerateTextInput): Promise<{ text: string; usage: Usage }> {
    const res = await callWithApiRetry(() =>
        ai.models.generateContent({
            model: MODEL,
            contents: input.prompt,
            config: {
                systemInstruction: input.system,
                temperature: input.temperature ?? 0,
                httpOptions: { timeout: REQUEST_TIMEOUT_MS },
            },
        }),
    );

    const usage: Usage = {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    };
    console.log(`[llm] ${MODEL} in=${usage.inputTokens} out=${usage.outputTokens}`);

    return { text: res.text ?? "", usage };
}

// ── Step 1 ─────────────────────────────────────────────────────────────

export type GenerateJsonInput = {
    system: string;
    prompt: string;
    jsonSchema: unknown;    // standard JSON Schema (e.g. from z.toJSONSchema)
    temperature?: number;   // defaults to 0: extraction has one right answer
};

export type GenerateJsonOutput = {
    text: string;                  // RAW text. Not parsed, not validated: that's the module's job.
    finishReason: string | null;   // "STOP" = normal. "MAX_TOKENS" / "SAFETY" usually mean broken JSON.
    usage: Usage;
};

// Throws LlmApiError only. Never parses JSON
export async function generateJson(input: GenerateJsonInput): Promise<GenerateJsonOutput> {
    const res = await callWithApiRetry(() =>
        ai.models.generateContent({
            model: MODEL,
            contents: input.prompt,
            config: {
                systemInstruction: input.system,
                temperature: input.temperature ?? 0,
                responseMimeType: "application/json",   // "reply in JSON"
                responseJsonSchema: input.jsonSchema,    // "...matching THIS shape"
                httpOptions: { timeout: REQUEST_TIMEOUT_MS },
            },
        }),
    );

    const usage: Usage = {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        // Thinking models bill "thoughts" as output too; count them so the logged cost is real.
        outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    };
    const finishReason = res.candidates?.[0]?.finishReason ?? null;
    console.log(`[llm] ${MODEL} json in=${usage.inputTokens} out=${usage.outputTokens} finish=${finishReason}`);

    // res.text is undefined when the response was blocked or empty → "" fails JSON.parse
    // in the module, which then retries with feedback.
    return { text: res.text ?? "", finishReason, usage };
}

// Step 2: tool calling ──────────────────────────────────────────────────────────────

// What the model sees for one tool. The module builds it from a Zod schema.
export type ToolSpec = {
    name: string;
    description: string;
    parametersJsonSchema: unknown;   // standard JSON Schema (z.toJSONSchema)
};

// One call the model asked for. `args` is unknown ON PURPOSE: it's untrusted
// until the module's Zod schema has validated it
export type ToolCall = {
    id: string | null;   // null when the provider didn't send one
    name: string;
    args: unknown;
};

// One result going back. Gemini only accepts an OBJECT as a function response,
// so tools return `{ orders: [...] }`, never a bare array.
export type ToolResultPart = {
    callId: string | null;
    name: string;
    result: Record<string, unknown>;
};

export type UserMessage = { role: "user"; text: string };
export type AssistantMessage = {
    role: "assistant";
    text: string | null;
    toolCalls: ToolCall[];
    // The provider's original turn, sent back UNCHANGED. Gemini attaches hidden thought
    // signatures to it; rebuilding the turn from text + toolCalls would drop them.
    // Modules treat it as an opaque box. null = not from the model in this run (e.g. B2 visible chat).
    raw: unknown;
};
export type ToolMessage = { role: "tool"; results: ToolResultPart[] };
export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export type ToolMode = "auto" | "any" | "none";

export type GenerateWithToolsInput = {
    system: string;                    // sent as systemInstruction, never inside messages
    messages: ChatMessage[];           // the whole history so far
    tools: ToolSpec[];                 // the allow-list for THIS flow (least privilege is the caller's job)
    mode?: ToolMode;                   // default "auto"; "any" = must call a tool; "none" = text only
    allowedTools?: string[] | null;    // only with mode "any"
    temperature?: number;              // default 0: tool choice should be repeatable
};

export type GenerateWithToolsOutput = {
    text: string | null;               // null when the model only called tools
    toolCalls: ToolCall[];             // EMPTY = the model is done (the stop signal)
    assistantMessage: AssistantMessage;   // push this into the history as-is
    finishReason: string | null;
    usage: Usage;
};

const MODE_MAP: Record<ToolMode, FunctionCallingConfigMode> = {
    auto: FunctionCallingConfigMode.AUTO,
    any: FunctionCallingConfigMode.ANY,
    none: FunctionCallingConfigMode.NONE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeminiContent(value: unknown): value is Content {
    return isRecord(value) && Array.isArray(value.parts);
}

// Neutral history → Gemini contents. Exported for the offline tests only; modules don't call it.
export function toGeminiContents(messages: ChatMessage[]): Content[] {
    return messages.map((m): Content => {
        switch (m.role) {
            case "user":
                return { role: "user", parts: [{ text: m.text }] };
            case "assistant": {
                if (isGeminiContent(m.raw)) return m.raw;   // as returned: keeps thought signatures
                // Fallback for assistant turns that never came from the model in this run.
                const parts: Part[] = [];
                if (m.text) parts.push({ text: m.text });
                for (const call of m.toolCalls) {
                    parts.push({
                        functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: isRecord(call.args) ? call.args : {} },
                    });
                }
                return { role: "model", parts };
            }
            case "tool":
                // Gemini has no "tool" role: results travel in a user turn, one functionResponse per call, same order.
                return {
                    role: "user",
                    parts: m.results.map((r): Part => ({
                        functionResponse: { ...(r.callId ? { id: r.callId } : {}), name: r.name, response: r.result },
                    })),
                };
        }
    });
}

function toGeminiTools(tools: ToolSpec[]): Tool[] {
    // parametersJsonSchema takes standard JSON Schema (the older `parameters` uses Gemini's Type.OBJECT format).
    return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parametersJsonSchema })) }];
}

// The part of a Gemini response we read. Structural, so tests can pass a plain object.
export type GeminiResponseLike = {
    candidates?: { content?: Content; finishReason?: string }[];
};

// Gemini response → neutral parts. Exported for the offline tests only.
// Reads the parts directly instead of res.text / res.functionCalls: res.text warns when
// function calls are present, and we want thought parts excluded from the text.
export function readToolResponse(res: GeminiResponseLike): {
    text: string | null;
    toolCalls: ToolCall[];
    raw: Content | null;
    finishReason: string | null;
} {
    const candidate = res.candidates?.[0];
    const content = candidate?.content ?? null;
    const parts = content?.parts ?? [];

    const toolCalls: ToolCall[] = [];
    const texts: string[] = [];
    for (const part of parts) {
        if (part.functionCall) {
            toolCalls.push({
                id: part.functionCall.id ?? null,
                name: part.functionCall.name ?? "",   // "" can't match a tool → the executor answers UNKNOWN_TOOL
                args: part.functionCall.args ?? {},
            });
        } else if (typeof part.text === "string" && !part.thought) {
            texts.push(part.text);
        }
    }

    const text = texts.join("").trim();
    // A response can hold BOTH text and calls; the caller treats "has calls" as "not done yet".
    return { text: text === "" ? null : text, toolCalls, raw: content, finishReason: candidate?.finishReason ?? null };
}

// Throws LlmApiError for provider failures, plain Error for caller bugs. Never executes a tool.
export async function generateWithTools(input: GenerateWithToolsInput): Promise<GenerateWithToolsOutput> {
    const mode = input.mode ?? "auto";
    const last = input.messages.at(-1);
    if (!last || last.role === "assistant") {
        throw new Error("generateWithTools: history must end with a user or tool message");
    }
    if (mode === "any" && input.tools.length === 0) {
        throw new Error("generateWithTools: mode 'any' needs at least one tool");
    }
    if (input.allowedTools && mode !== "any") {
        throw new Error("generateWithTools: allowedTools only works with mode 'any'");
    }

    const hasTools = input.tools.length > 0;
    const res = await callWithApiRetry(() =>
        ai.models.generateContent({
            model: MODEL,
            contents: toGeminiContents(input.messages), // the conversation so far
            config: {
                systemInstruction: input.system,
                temperature: input.temperature ?? 0,
                // An empty functionDeclarations list is rejected, so send tools only when there are some.
                ...(hasTools
                    ? {
                        tools: toGeminiTools(input.tools),
                        toolConfig: {
                            functionCallingConfig: {
                                mode: MODE_MAP[mode],
                                ...(input.allowedTools ? { allowedFunctionNames: input.allowedTools } : {}),
                            },
                        },
                    }
                    : {}),
                httpOptions: { timeout: REQUEST_TIMEOUT_MS },
            },
        }),
    );

    const usage: Usage = {
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    };
    const { text, toolCalls, raw, finishReason } = readToolResponse(res);
    console.log(
        `[llm] ${MODEL} tools in=${usage.inputTokens} out=${usage.outputTokens} calls=${toolCalls.length} finish=${finishReason}`,
    );

    return {
        text,
        toolCalls,
        assistantMessage: { role: "assistant", text, toolCalls, raw },
        finishReason,
        usage,
    };
}



// ── Step 4 (Mini 2): embeddings ──────────────────────────────────────────────────────
//
// embed() turns texts into vectors. Same rules as the rest of this file: Gemini names
// stay here, provider failures become LlmApiError, modules see plain number[][].
//
//   - one vector per input text, SAME ORDER, same count
//   - exactly EMBEDDING_DIMENSIONS numbers each (the pgvector column is vector(768))
//   - normalised to length 1, so cosine similarity = dot product
//   - documents use "RETRIEVAL_DOCUMENT", questions use "RETRIEVAL_QUERY"
//   - Changing the model or the dimension = new column + re-embed everything.

export const EMBEDDING_DIMENSIONS = 768;

// Gemini accepts up to 100 texts per embedContent request (verify in the current docs;
// if they change, only this number changes). Bigger arrays are split here, not by callers.
export const EMBED_BATCH_SIZE = 100;

// The task types this project uses. Gemini has more (CLASSIFICATION, CLUSTERING, ...);
// add one here only when a module really needs it.
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY";

export type EmbedOptions = {
    taskType: EmbeddingTaskType;   // required on purpose: the wrong task type silently lowers search quality
};

// Splits [t1..t250] into [[t1..t100], [t101..t200], [t201..t250]]. Exported for the offline tests.
export function splitIntoBatches<T>(items: T[], size: number = EMBED_BATCH_SIZE): T[][] {
    if (!Number.isInteger(size) || size < 1) throw new Error(`splitIntoBatches: invalid size ${size}`);
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
    return batches;
}

// The part of a Gemini embedContent response we read. Structural, so tests can pass a plain object.
export type EmbedResponseLike = {
    embeddings?: { values?: number[] }[];
};

// Gemini response → validated, normalised vectors. Exported for the offline tests only.
// Throws a plain Error when the response breaks the contract: that is never safe to store,
// and retrying the same request would very likely return the same broken shape.
export function readEmbeddingResponse(
    res: EmbedResponseLike,
    expectedCount: number,
    dimensions: number = EMBEDDING_DIMENSIONS,
): Vector[] {
    const embeddings = res.embeddings ?? [];
    if (embeddings.length !== expectedCount) {
        // Order and count are the whole contract: vector i MUST belong to text i.
        throw new Error(`embed: expected ${expectedCount} embeddings, got ${embeddings.length}`);
    }
    return embeddings.map((embedding, i) => {
        const values = embedding.values ?? [];
        if (values.length !== dimensions) {
            throw new Error(`embed: embedding ${i} has ${values.length} dimensions, expected ${dimensions}`);
        }
        if (!isFiniteVector(values)) throw new Error(`embed: embedding ${i} contains NaN or Infinity`);
        // Gemini only normalises the full 3072-d output. A truncated 768-d vector is NOT
        // unit length, so we normalise it here, once, for every caller.
        return normalize(values);
    });
}

// Throws LlmApiError for provider failures, plain Error for caller bugs or a broken response.
// Never stores anything: storage is Part 2's job.
export async function embed(texts: string[], options: EmbedOptions): Promise<Vector[]> {
    if (texts.length === 0) return [];
    const emptyIndex = texts.findIndex((t) => t.trim() === "");
    if (emptyIndex !== -1) {
        // An empty string still gets a vector (a meaningless one). Refuse instead of storing noise.
        throw new Error(`embed: text ${emptyIndex} is empty`);
    }

    const vectors: Vector[] = [];
    // Sequential, not Promise.all: a few batches is fast enough, and parallel batches hit
    // the rate limit (429) sooner. Each batch gets the normal API retry policy.
    for (const batch of splitIntoBatches(texts)) {
        const res = await callWithApiRetry(() =>
            ai.models.embedContent({
                model: EMBEDDING_MODEL,
                contents: batch,   // string[] → one embedding per string, same order
                config: {
                    taskType: options.taskType,
                    outputDimensionality: EMBEDDING_DIMENSIONS,
                    httpOptions: { timeout: REQUEST_TIMEOUT_MS },
                },
            }),
        );
        vectors.push(...readEmbeddingResponse(res, batch.length));
    }

    console.log(`[llm] ${EMBEDDING_MODEL} embed texts=${texts.length} task=${options.taskType} dims=${EMBEDDING_DIMENSIONS}`);
    return vectors;
}
