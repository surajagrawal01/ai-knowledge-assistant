// GENERIC: any Zod schema + prompt → validated data, with retry-with-feedback.
// It knows NOTHING about tickets. When a second module needs it (Mini 2 RAG answers),
// it moves to core. Until then it lives here.
import { z } from "zod";
import { addUsage, generateJson, LlmApiError, ZERO_USAGE, type Usage } from "../../core/llm.js";

export type StructuredFailureReason = "api" | "not_json" | "schema";

export type StructuredResult<T> =
    | { ok: true; data: T; attempts: number; usage: Usage }
    | { ok: false; reason: StructuredFailureReason; attempts: number; usage: Usage; details: unknown };

export type GenerateStructuredInput<T> = {
    schema: z.ZodType<T>;
    system: string;
    input: string;
    maxAttempts?: number;   // parse/schema attempts. API retries are separate (inside core/llm.ts).
};

const DEFAULT_MAX_ATTEMPTS = 2;
const HARD_MAX_ATTEMPTS = 3;          // a caller can't accidentally ask for 50 paid retries
const MAX_RAW_IN_FEEDBACK = 500;      // enough to show the mistake, not enough to blow up tokens

type AttemptCheck<T> =
    | { ok: true; data: T }
    | { ok: false; reason: "not_json" | "schema"; feedback: string; details: unknown };

// Layer ② parse and layer ③ schema. Pure function: easy to test without the API.
export function parseAndValidate<T>(schema: z.ZodType<T>, raw: string, finishReason: string | null): AttemptCheck<T> {
    let json: unknown;   // unknown
    try {
        json = JSON.parse(raw);
    } catch {
        const why = raw.trim() === "" ? "the response was empty" : "the response was not valid JSON";
        return {
            ok: false,
            reason: "not_json",
            feedback: `${why} (finishReason: ${finishReason ?? "unknown"}).`,
            details: { finishReason, rawPreview: raw.slice(0, MAX_RAW_IN_FEEDBACK) },
        };
    }

    const result = schema.safeParse(json);
    if (!result.success) {
        // Compact "path: message" lines are easier for the model to act on than raw issue objects.
        const problems = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
        return {
            ok: false,
            reason: "schema",
            feedback: `${problems.join("; ")}. Your output was: ${raw.slice(0, MAX_RAW_IN_FEEDBACK)}`,
            details: { issues: result.error.issues },
        };
    }

    return { ok: true, data: result.data };
}

// Generic retry text. Kept here (not in a module's *.prompt.ts) because it is
// schema-agnostic and must not depend on any one module.
function retryFeedback(problem: string): string {
    return `\n\nYour previous output was invalid: ${problem}\nReturn corrected JSON that matches the schema exactly. Do not add any other text.`;
}

// Never throws for AI/provider failures; returns { ok: false } instead.
// Programming errors (bugs) still throw, so they reach the 500 handler instead of being hidden.
export async function generateStructured<T>(opts: GenerateStructuredInput<T>): Promise<StructuredResult<T>> {
    const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1), HARD_MAX_ATTEMPTS);
    const jsonSchema = z.toJSONSchema(opts.schema);   // one source of truth: Zod → JSON Schema

    let usage = ZERO_USAGE;
    let feedback = "";
    let last: { reason: StructuredFailureReason; details: unknown } = { reason: "schema", details: null };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let response;
        try {
            response = await generateJson({ system: opts.system, prompt: opts.input + feedback, jsonSchema });
        } catch (err) {
            //core/llm.ts already retried 429/5xx with backoff; re-asking here won't help.
            if (err instanceof LlmApiError) {
                return { ok: false, reason: "api", attempts: attempt, usage, details: { status: err.status, message: err.message } };
            }
            throw err;
        }

        usage = addUsage(usage, response.usage);
        const check = parseAndValidate(opts.schema, response.text, response.finishReason);
        if (check.ok) return { ok: true, data: check.data, attempts: attempt, usage };

        last = { reason: check.reason, details: check.details };
        feedback = retryFeedback(check.feedback);   // feed the error back
    }

    return { ok: false, reason: last.reason, attempts: maxAttempts, usage, details: last.details };
}
