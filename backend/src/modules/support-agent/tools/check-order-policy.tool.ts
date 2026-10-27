import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { checkOrderAccess, OrderIdSchema } from "./common.js";
import { evaluateOrderPolicy } from "./order-policy.js";
import { defineTool } from "./types.js";

const CheckOrderPolicyArgs = z.object({ orderId: OrderIdSchema });

// A thin adapter: DB → pure function. All rules live (and are tested) in order-policy.ts.
export const checkOrderPolicy = defineTool({
  name: "checkOrderPolicy",
  description:
    "Check an order against ElectroNest's rules, computed exactly: is each item returnable, is it under warranty, " +
    "is the delivery delayed, is the damaged-on-arrival window still open. Each answer has a reason you can quote. " +
    "Always use this for return, warranty, damage or delay questions. Never calculate these yourself.",
  args: CheckOrderPolicyArgs,
  kind: "read",
  async run({ orderId }, ctx) {
    const access = checkOrderAccess(
      await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, category: true, returnWindowDays: true, warrantyMonths: true } },
            },
          },
        },
      }),
      orderId,
      ctx,
    );
    if (!access.ok) return access.error;
    const { order } = access;

    const policy = evaluateOrderPolicy(
      {
        orderId: order.id,
        status: order.status,
        zone: order.shippingZone,
        shippedAt: order.shippedAt,
        deliveredAt: order.deliveredAt,
        items: order.items.map((i) => ({
          productId: i.product.id,
          name: i.product.name,
          category: i.product.category,
          returnWindowDays: i.product.returnWindowDays,
          warrantyMonths: i.product.warrantyMonths,
        })),
      },
      ctx.now,
    );
    return { ...policy };
  },
});
