// ElectroNest's order rules, computed in CODE
// No Prisma, no Gemini, no `new Date()`: `now` is a parameter, so tests pin it.
// Numbers come from knowledge-base/FACTS.md. Return windows and warranty months come
// from each product row (the seed already matches FACTS.md).
import type { OrderStatus, ProductCategory, ShippingZone } from "@prisma/client";
import { daysAgo } from "./common.js";

// FACTS.md › SHIPPING: delivery days per zone (upper bound)
export const ZONE_MAX_DELIVERY_DAYS: Readonly<Record<ShippingZone, number>> = { A: 3, B: 5, C: 8 };
// FACTS.md › SHIPPING: "delayed after max days + 2 grace days"
export const DELAY_GRACE_DAYS = 2;
// FACTS.md › DAMAGED ON ARRIVAL: "within 48 hours of delivery"
export const DOA_REPORT_WINDOW_HOURS = 48;
// FACTS.md › RETURNS: conditions code can't check, so a human must
export const RETURN_CONDITIONS = ["unused", "in the original box"] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type PolicyItem = {
  productId: string;
  name: string;
  category: ProductCategory;
  returnWindowDays: number;
  warrantyMonths: number;
};

export type PolicyInput = {
  orderId: string;
  status: OrderStatus;
  zone: ShippingZone;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  items: PolicyItem[];
};

export type DeliveryCheck =
  | {
    applicable: true;
    zone: ShippingZone;
    maxDays: number;
    graceDays: number;
    thresholdDays: number;
    daysSinceShipped: number;
    delayed: boolean;
    daysOverThreshold: number;
    reason: string;
  }
  | { applicable: false; reason: string };

export type ReturnCheck =
  | { eligible: true; windowDays: number; daysLeft: number; conditions: readonly string[]; reason: string }
  | { eligible: false; windowDays: number; reason: string };

export type WarrantyCheck =
  | { active: true; months: number; daysLeft: number; reason: string }
  | { active: false; months: number; reason: string };

export type ItemPolicy = {
  productId: string;
  name: string;
  category: ProductCategory;
  return: ReturnCheck;
  warranty: WarrantyCheck;
};

export type OrderPolicy = {
  orderId: string;
  status: OrderStatus;
  daysSinceShipped: number | null;
  daysSinceDelivery: number | null;
  delivery: DeliveryCheck;
  // Per item, not per order: a laptop (10 days / 12 months) and a charger (7 days / 6 months)
  // in one order have different rules.
  items: ItemPolicy[];
  damagedOnArrival: { windowOpen: boolean; windowHours: number; reason: string };
};

// Why "not delivered" for each status, so the model can quote a reason instead of guessing one.
const NOT_DELIVERED_REASON: Readonly<Record<OrderStatus, string>> = {
  placed: "not shipped yet",
  shipped: "not delivered yet",
  delivered: "delivered",
  cancelled: "order was cancelled",
  returned: "order was already returned",
};

// Calendar months, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb, not 3 Mar).
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function checkDelivery(input: PolicyInput, daysSinceShipped: number | null): DeliveryCheck {
  if (input.status !== "shipped") {
    const reason = input.status === "delivered" ? "already delivered" : NOT_DELIVERED_REASON[input.status];
    return { applicable: false, reason };
  }
  if (daysSinceShipped === null) return { applicable: false, reason: "ship date missing" };

  const maxDays = ZONE_MAX_DELIVERY_DAYS[input.zone];
  const thresholdDays = maxDays + DELAY_GRACE_DAYS;
  const delayed = daysSinceShipped > thresholdDays;   // day 7 in zone B is still on time; day 8 is late
  return {
    applicable: true,
    zone: input.zone,
    maxDays,
    graceDays: DELAY_GRACE_DAYS,
    thresholdDays,
    daysSinceShipped,
    delayed,
    daysOverThreshold: Math.max(0, daysSinceShipped - thresholdDays),
    reason: `shipped ${daysSinceShipped} days ago; zone ${input.zone} counts as delayed after ${thresholdDays} days`,
  };
}

function checkReturn(input: PolicyInput, item: PolicyItem, daysSinceDelivery: number | null): ReturnCheck {
  const windowDays = item.returnWindowDays;
  if (input.status !== "delivered") return { eligible: false, windowDays, reason: NOT_DELIVERED_REASON[input.status] };
  if (daysSinceDelivery === null) return { eligible: false, windowDays, reason: "delivery date missing" };

  const reason = `delivered ${daysSinceDelivery} days ago; return window is ${windowDays} days`;
  // Inclusive: delivered exactly `windowDays` days ago is still returnable (the last day of the window counts).
  if (daysSinceDelivery <= windowDays) {
    return { eligible: true, windowDays, daysLeft: windowDays - daysSinceDelivery, conditions: RETURN_CONDITIONS, reason };
  }
  return { eligible: false, windowDays, reason };
}

function checkWarranty(input: PolicyInput, item: PolicyItem, now: Date): WarrantyCheck {
  const months = item.warrantyMonths;
  if (input.status !== "delivered") return { active: false, months, reason: NOT_DELIVERED_REASON[input.status] };
  if (input.deliveredAt === null) return { active: false, months, reason: "delivery date missing" };

  const expiresAt = addMonths(input.deliveredAt, months);
  const msLeft = expiresAt.getTime() - now.getTime();
  if (msLeft > 0) {
    const daysLeft = Math.floor(msLeft / DAY_MS);
    return { active: true, months, daysLeft, reason: `${months}-month warranty from delivery; ${daysLeft} days left` };
  }
  const daysAgoExpired = Math.floor(-msLeft / DAY_MS);
  return { active: false, months, reason: `${months}-month warranty expired ${daysAgoExpired} days ago` };
}

function checkDamagedOnArrival(input: PolicyInput, now: Date): OrderPolicy["damagedOnArrival"] {
  const windowHours = DOA_REPORT_WINDOW_HOURS;
  if (input.status !== "delivered" || input.deliveredAt === null) {
    return { windowOpen: false, windowHours, reason: NOT_DELIVERED_REASON[input.status] };
  }
  const hours = Math.max(0, Math.floor((now.getTime() - input.deliveredAt.getTime()) / HOUR_MS));
  const windowOpen = hours <= windowHours;
  return {
    windowOpen,
    windowHours,
    reason: `delivered ${hours} hours ago; damage must be reported within ${windowHours} hours`,
  };
}

export function evaluateOrderPolicy(input: PolicyInput, now: Date): OrderPolicy {
  const daysSinceShipped = daysAgo(input.shippedAt, now);
  const daysSinceDelivery = daysAgo(input.deliveredAt, now);

  return {
    orderId: input.orderId,
    status: input.status,
    daysSinceShipped,
    daysSinceDelivery,
    delivery: checkDelivery(input, daysSinceShipped),
    items: input.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      category: item.category,
      return: checkReturn(input, item, daysSinceDelivery),
      warranty: checkWarranty(input, item, now),
    })),
    damagedOnArrival: checkDamagedOnArrival(input, now),
  };
}
