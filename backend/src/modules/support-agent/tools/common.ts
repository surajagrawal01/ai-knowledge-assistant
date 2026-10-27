// Helpers shared by the tools. Everything here is pure (no DB call), so it's tested offline.
import { z } from "zod";
import { TOOL_ERROR_CODES, type ToolContext, type ToolError, type ToolErrorCode } from "./types.js";

const DAY_MS = 86_400_000;

// Normalise BEFORE the format check: the model copies "o020" from Hinglish messages, and
// rejecting it would waste a round trip for no safety gain. "O777" still fails later, at the DB.
export const CustomerIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^C\d{3}$/, "must look like C002 (C + 3 digits)")
  .describe(
    "Customer ID: C + 3 digits, e.g. C002. Must come from the user's message or a previous tool result. Never guess.",
  );

export const OrderIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^O\d{3}$/, "must look like O020 (O + 3 digits)")
  .describe(
    "Order ID: O + 3 digits, e.g. O020. Must come from the user's message or a previous tool result. Never guess.",
  );

export function toolError(code: ToolErrorCode, message: string, extra: Record<string, unknown> = {}): ToolError {
  return { ...extra, error: code, message };   // code + message last: `extra` can't overwrite them
}

const ERROR_CODES: ReadonlySet<string> = new Set(TOOL_ERROR_CODES);

export function isToolError(value: unknown): value is ToolError {
  return (
    typeof value === "object" && value !== null &&
    "error" in value && typeof value.error === "string" && ERROR_CODES.has(value.error) &&
    "message" in value && typeof value.message === "string"
  );
}

// Whole days since `date`. Relative days stop the model doing date maths.
// A future date (bad data) gives 0, never a negative number.
export function daysAgo(date: Date | null, now: Date): number | null {
  if (date === null) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

// Prisma Decimal → plain rupees. Decimal objects serialise as strings; the model needs 4999.
export function toInr(value: { toNumber(): number } | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

export type OrderAccess<T> = { ok: true; order: T } | { ok: false; error: ToolError };

// Ownership in ONE place: every orderId tool loads its order (with the includes it
// needs) and passes it through here. Generic, so the caller gets its own order type back, narrowed.
// The mismatch error carries NO order details: C002 must learn nothing about C007's order.
export function checkOrderAccess<T extends { customerId: string }>(
  order: T | null,
  orderId: string,
  ctx: ToolContext,
): OrderAccess<T> {
  if (order === null) return { ok: false, error: toolError("NOT_FOUND", `No order with id ${orderId}`) };
  if (ctx.customerId !== null && order.customerId !== ctx.customerId) {
    return {
      ok: false,
      error: toolError("OWNERSHIP_MISMATCH", `Order ${orderId} does not belong to customer ${ctx.customerId}`),
    };
  }
  return { ok: true, order };
}
