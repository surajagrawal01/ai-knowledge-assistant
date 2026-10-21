// Never throws for AI failures (F1). Bugs still throw and become a 500 in the route.

import { generateStructured } from "./structured-output.js";
import { checkExtractionLocally } from "./ticket-extractor.checks.js";
import { buildUserContent, EXTRACTION_SYSTEM_PROMPT } from "./ticket.prompt.js";
import { ExtractResult, MAX_MESSAGE_LENGTH, TicketExtractionSchema } from "./ticket.schema.js";

const MAX_ATTEMPTS = 2;   // 1 call + 1 retry with feedback: fixes most slips

type LogLine = {
    module: "extract";
    ok: boolean;
    reason?: string;
    attempts: number;
    warnings: string[];
    ms: number;
    tokens: number;
    chars: number;   // message length only: never log the message
};


function log(line: LogLine): void {
    console.log(JSON.stringify(line));
}

// Never throws errors for AI failures. Bugs still throw and become a 500 in the route.
// `today` is a parameter so evals/tests can pin the date.
export async function extractTicket(message: string, today: Date = new Date()): Promise<ExtractResult> {
    const started = Date.now();
    const text = message.trim();

    // Cheap guards first: no point paying for a model call on empty or huge input.
    // The route already returns 400 for these; this protects non-HTTP callers (triage, evals).
    if (text === "") {
        log({ module: "extract", ok: false, reason: "empty_input", attempts: 0, warnings: [], ms: 0, tokens: 0, chars: 0 });
        return { ok: false, reason: "empty_input", attempts: 0 };
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
        log({ module: "extract", ok: false, reason: "too_long", attempts: 0, warnings: [], ms: 0, tokens: 0, chars: text.length });
        return { ok: false, reason: "too_long", attempts: 0, details: { max: MAX_MESSAGE_LENGTH } };
    }

    const result = await generateStructured({
        schema: TicketExtractionSchema,
        system: EXTRACTION_SYSTEM_PROMPT,
        input: buildUserContent(text, today),
        maxAttempts: MAX_ATTEMPTS,
    });

    const ms = Date.now() - started;
    const tokens = result.usage.inputTokens + result.usage.outputTokens;

    if (!result.ok) {
        log({ module: "extract", ok: false, reason: result.reason, attempts: result.attempts, warnings: [], ms, tokens, chars: text.length });
        return { ok: false, reason: result.reason, attempts: result.attempts, details: result.details };
    }

    // Valid shape ≠ true content: run the business checks on the validated data.
    const { ticket, warnings } = checkExtractionLocally(result.data, text);

    log({ module: "extract", ok: true, attempts: result.attempts, warnings, ms, tokens, chars: text.length });
    return { ok: true, ticket, warnings, attempts: result.attempts };
}