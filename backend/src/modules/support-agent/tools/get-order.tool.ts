import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { checkOrderAccess, daysAgo, OrderIdSchema, toInr } from "./common.js";
import { defineTool } from "./types.js";

const GetOrderArgs = z.object({ orderId: OrderIdSchema });

export const getOrder = defineTool({
  name: "getOrder",
  description:
    "Get full details of ONE order: status, items, amounts, shipping zone, and days since ordered/shipped/delivered. " +
    "For return, warranty, damage or delay questions, use checkOrderPolicy instead of reasoning about dates yourself.",
  args: GetOrderArgs,
  kind: "read",
  async run({ orderId }, ctx) {
    const access = checkOrderAccess(
      await prisma.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { product: { select: { name: true, category: true } } } } },
      }),
      orderId,
      ctx,
    );
    if (!access.ok) return access.error;
    const { order } = access;

    return {
      id: order.id,
      customerId: order.customerId,
      status: order.status,
      zone: order.shippingZone,
      orderedDaysAgo: daysAgo(order.orderedAt, ctx.now),
      shippedDaysAgo: daysAgo(order.shippedAt, ctx.now),
      deliveredDaysAgo: daysAgo(order.deliveredAt, ctx.now),
      items: order.items.map((i) => ({
        name: i.product.name,
        category: i.product.category,
        quantity: i.quantity,
        unitPriceInr: toInr(i.unitPrice),
      })),
      subtotalInr: toInr(order.subtotal),
      shippingFeeInr: toInr(order.shippingFee),
      totalInr: toInr(order.totalAmount),
    };
  },
});
