import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { checkOrderAccess, daysAgo, OrderIdSchema, toInr } from "./common.js";
import { defineTool } from "./types.js";

const GetPaymentArgs = z.object({ orderId: OrderIdSchema });

export const getPayment = defineTool({
  name: "getPayment",
  description:
    "Get the payment records for one order: method (upi, card, netbanking, emi, cod), status (pending, paid, " +
    "failed, refunded) and amount, newest first. Use for payment, refund or 'money deducted' questions.",
  args: GetPaymentArgs,
  kind: "read",
  async run({ orderId }, ctx) {
    const access = checkOrderAccess(
      await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          customerId: true,
          status: true,
          // Payments have no created timestamp and paidAt is null for failed ones; IDs are
          // assigned in creation order, so id desc = newest first.
          payments: { orderBy: { id: "desc" } },
        },
      }),
      orderId,
      ctx,
    );
    if (!access.ok) return access.error;
    const { order } = access;

    // ALL rows, not just one: "failed, then paid" is a story a single row would hide (C005).
    const payments = order.payments.map((p) => ({
      method: p.method,
      status: p.status,
      amountInr: toInr(p.amount),
      paidDaysAgo: daysAgo(p.paidAt, ctx.now),
    }));

    return {
      orderId: order.id,
      orderStatus: order.status,
      latestStatus: payments[0]?.status ?? null,
      // "Never refund twice" (C006) is a business rule: computed here, not inferred by the model.
      alreadyRefunded: payments.some((p) => p.status === "refunded"),
      payments,
    };
  },
  summarize(r) {
    const latest = r.payments[0];
    if (latest === undefined) return "no payments";
    const more = r.payments.length > 1 ? ` (${r.payments.length} records)` : "";
    return `${latest.method} · ${latest.status} · ₹${latest.amountInr.toLocaleString("en-IN")}${more}`;
  },
});
