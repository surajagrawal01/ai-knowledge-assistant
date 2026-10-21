// The ONLY file that imports the Gemini SDK.
// Modules call the functions below; they never import "@google/genai".
// This file only translates ONE call to Gemini and back (+ API-level retries).
import { ApiError, GoogleGenAI } from "@google/genai";
import { env } from "./env.js";

export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
export const MODEL = env.GEMINI_MODEL;

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

// Throws LlmApiError only. Never parses JSON (rule 16 lives in the module).
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
