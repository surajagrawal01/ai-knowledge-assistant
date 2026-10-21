// Semantic checks/ Manual Checks: the JSON has the right SHAPE, but is it TRUE?
// Policy: fail safe. A wrong value becomes null + a warning (a missing ID can be
// looked up in Step 2; a wrong ID can refund the wrong customer). No retries here:
import type { TicketExtraction } from "./ticket.schema.js";

export type CheckResult = { ticket: TicketExtraction; warnings: string[] };

// Whole-token, case-insensitive match. A plain .includes() would accept "C999"
// because "C9999" contains it; \b stops at letters and digits.
function containsToken(message: string, value: string): boolean {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(message);
}

function digitsOnly(s: string): string {
    return s.replace(/\D/g, "");
}

// Models sometimes return "" or "  " instead of null. Treat blank as missing.
function blankToNull(value: string | null): string | null {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

export function checkExtractionLocally(input: TicketExtraction, message: string): CheckResult {
    const warnings: string[] = [];
    const t: TicketExtraction = {
        ...input,
        customer_name: blankToNull(input.customer_name),
        customer_email: blankToNull(input.customer_email),
        customer_phone: blankToNull(input.customer_phone),
        products_mentioned: input.products_mentioned.map((p) => p.trim()).filter((p) => p !== ""),
    };

    // IDs must literally appear in the message (customers also type "c002", so case-insensitive).
    if (t.customer_id && !containsToken(message, t.customer_id)) {
        warnings.push(`customer_id ${t.customer_id} not in message → removed`);
        t.customer_id = null;
    }
    if (t.order_id && !containsToken(message, t.order_id)) {
        warnings.push(`order_id ${t.order_id} not in message → removed`);
        t.order_id = null;
    }

    // Email: must look like one AND be written in the message.
    if (t.customer_email && (!t.customer_email.includes("@") || !message.toLowerCase().includes(t.customer_email.toLowerCase()))) {
        warnings.push("customer_email not found in message → removed");
        t.customer_email = null;
    }

    // Phone: compare digits only, so "+91 92691 66978" matches "9269166978" written differently.
    // Fewer than 7 digits is not a phone number we can use.
    if (t.customer_phone) {
        const phoneDigits = digitsOnly(t.customer_phone);
        if (phoneDigits.length < 7 || !digitsOnly(message).includes(phoneDigits)) {
            warnings.push("customer_phone not found in message → removed");
            t.customer_phone = null;
        }
    }

    // Name must be written in the message (never invent data).
    if (t.customer_name && !message.toLowerCase().includes(t.customer_name.toLowerCase())) {
        warnings.push("customer_name not found in message → removed");
        t.customer_name = null;
    }

    // Suspicious but not provably wrong: keep the values, flag for review.
    if (t.needs_human && t.priority === "low") {
        warnings.push("needs_human is true but priority is low → review");
    }

    return { ticket: t, warnings };
}
