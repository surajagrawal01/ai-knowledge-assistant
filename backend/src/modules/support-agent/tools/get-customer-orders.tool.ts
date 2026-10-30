import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { CustomerIdSchema, daysAgo, toInr, toolError } from "./common.js";
import { defineTool } from "./types.js";

const DEFAULT_LIMIT = 5;

const GetCustomerOrdersArgs = z.object({
  customerId: CustomerIdSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .nullable()
    .describe(`How many recent orders to return (1-10); null = ${DEFAULT_LIMIT}`),
});

export const getCustomerOrders = defineTool({
  name: "getCustomerOrders",
  description:
    "List a customer's orders, newest first, as short summaries (id, status, days ago, products, total). " +
    "Use when you know the customer ID and need to find which order they mean ('my latest order', " +
    "'the headphones I bought'). Use getOrder for full details of one order.",
  args: GetCustomerOrdersArgs,
  kind: "read",
  async run({ customerId, limit }, ctx) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (customer === null) return toolError("NOT_FOUND", `No customer with id ${customerId}`);

    const [totalOrders, orders] = await Promise.all([
      prisma.order.count({ where: { customerId } }),
      prisma.order.findMany({
        where: { customerId },
        orderBy: { orderedAt: "desc" },
        take: limit ?? DEFAULT_LIMIT,
        include: { items: { include: { product: { select: { name: true } } } } },
      }),
    ]);

    return {
      customerId,
      totalOrders,
      showing: orders.length,   // with totalOrders, tells the model there may be more (ask with a bigger limit)
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        orderedDaysAgo: daysAgo(o.orderedAt, ctx.now),
        shippedDaysAgo: daysAgo(o.shippedAt, ctx.now),
        deliveredDaysAgo: daysAgo(o.deliveredAt, ctx.now),
        products: o.items.map((i) => (i.quantity > 1 ? `${i.product.name} x${i.quantity}` : i.product.name)),
        totalInr: toInr(o.totalAmount),
      })),
    };
  },
  summarize(r) {
    const latest = r.orders[0];
    return latest === undefined ? "no orders" : `${r.totalOrders} orders, latest ${latest.id} (${latest.status})`;
  },
});
