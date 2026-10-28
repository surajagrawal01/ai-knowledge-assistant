// npm run test:policy   — no DB, no API key, no .env.
// The business rules from FACTS.md, checked with FIXED dates so they never drift
// (the seed stores "N days before you seeded", the DB is the wrong place to test rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addMonths,
  evaluateOrderPolicy,
  type PolicyInput,
  type PolicyItem,
} from "../../src/modules/support-agent/tools/order-policy.js";

const NOW = new Date("2026-09-29T10:00:00Z");
const DAY_MS = 86_400_000;
const daysBefore = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const hoursBefore = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

// Product rules as in the seed (FACTS.md): audio/phone/accessory 7-day return, laptop 10.
const NESTBUDS: PolicyItem = { productId: "P006", name: "NestBuds Pro", category: "audio", returnWindowDays: 7, warrantyMonths: 6 };
const PHONE: PolicyItem = { productId: "P003", name: "NestPhone 12", category: "phone", returnWindowDays: 7, warrantyMonths: 12 };
const LAPTOP: PolicyItem = { productId: "P001", name: "NestBook Air 14", category: "laptop", returnWindowDays: 10, warrantyMonths: 12 };
const CHARGER: PolicyItem = { productId: "P008", name: "NestCharge 65W", category: "accessory", returnWindowDays: 7, warrantyMonths: 6 };

function order(overrides: Partial<PolicyInput>): PolicyInput {
  return { orderId: "O999", status: "delivered", zone: "A", shippedAt: null, deliveredAt: null, items: [PHONE], ...overrides };
}

// ── delivery delay (planted stories) ────────────────────────────────────

test("O020: zone B, shipped 9 days ago → delayed by 2 (threshold 5 + 2 = 7)", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O020", status: "shipped", zone: "B", shippedAt: daysBefore(9), items: [NESTBUDS] }), NOW);
  assert.equal(p.delivery.applicable, true);
  if (p.delivery.applicable) {
    assert.equal(p.delivery.thresholdDays, 7);
    assert.equal(p.delivery.daysSinceShipped, 9);
    assert.equal(p.delivery.delayed, true);
    assert.equal(p.delivery.daysOverThreshold, 2);
    assert.match(p.delivery.reason, /zone B/);
  }
  // Not delivered yet: nothing to return, warranty hasn't started.
  assert.equal(p.items[0]?.return.eligible, false);
  assert.equal(p.items[0]?.return.reason, "not delivered yet");
  assert.equal(p.items[0]?.warranty.active, false);
});

test("O050: zone C, shipped 5 days ago → NOT delayed (threshold 8 + 2 = 10)", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O050", status: "shipped", zone: "C", shippedAt: daysBefore(5) }), NOW);
  assert.equal(p.delivery.applicable, true);
  if (p.delivery.applicable) {
    assert.equal(p.delivery.thresholdDays, 10);
    assert.equal(p.delivery.delayed, false);
    assert.equal(p.delivery.daysOverThreshold, 0);
  }
});

test("delay boundary: zone B day 7 is on time, day 8 is late", () => {
  const day7 = evaluateOrderPolicy(order({ status: "shipped", zone: "B", shippedAt: daysBefore(7) }), NOW);
  const day8 = evaluateOrderPolicy(order({ status: "shipped", zone: "B", shippedAt: daysBefore(8) }), NOW);
  assert.equal(day7.delivery.applicable && day7.delivery.delayed, false);
  assert.equal(day8.delivery.applicable && day8.delivery.delayed, true);
  assert.equal(day8.delivery.applicable && day8.delivery.daysOverThreshold, 1);
});

test("delivery check only applies to shipped orders", () => {
  const placed = evaluateOrderPolicy(order({ status: "placed" }), NOW);
  const delivered = evaluateOrderPolicy(order({ status: "delivered", deliveredAt: daysBefore(2) }), NOW);
  assert.deepEqual(placed.delivery, { applicable: false, reason: "not shipped yet" });
  assert.deepEqual(delivered.delivery, { applicable: false, reason: "already delivered" });
});

test("shipped with no ship date → not applicable, no crash", () => {
  const p = evaluateOrderPolicy(order({ status: "shipped", shippedAt: null }), NOW);
  assert.deepEqual(p.delivery, { applicable: false, reason: "ship date missing" });
});

// ── returns ─────────────────────────────────────────────────────────────

test("O025: phone delivered 3 days ago → returnable, 4 days left, conditions listed", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O025", deliveredAt: daysBefore(3), items: [PHONE] }), NOW);
  const r = p.items[0]?.return;
  assert.equal(r?.eligible, true);
  if (r?.eligible) {
    assert.equal(r.daysLeft, 4);
    assert.deepEqual([...r.conditions], ["unused", "in the original box"]);
  }
});

test("O028: audio delivered 20 days ago → NOT returnable, but under 6-month warranty", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O028", deliveredAt: daysBefore(20), items: [NESTBUDS] }), NOW);
  assert.equal(p.items[0]?.return.eligible, false);
  assert.match(p.items[0]?.return.reason ?? "", /20 days ago; return window is 7 days/);
  const w = p.items[0]?.warranty;
  assert.equal(w?.active, true);
  if (w?.active) assert.ok(w.daysLeft > 150 && w.daysLeft < 165, `daysLeft was ${w.daysLeft}`);
});

test("return boundary: day 7 of a 7-day window is still returnable (0 left); day 8 is not", () => {
  const day7 = evaluateOrderPolicy(order({ deliveredAt: daysBefore(7) }), NOW).items[0]?.return;
  const day8 = evaluateOrderPolicy(order({ deliveredAt: daysBefore(8) }), NOW).items[0]?.return;
  assert.equal(day7?.eligible, true);
  if (day7?.eligible) assert.equal(day7.daysLeft, 0);
  assert.equal(day8?.eligible, false);
});

test("mixed order delivered 9 days ago: laptop returnable (10 days), charger not (7 days)", () => {
  const p = evaluateOrderPolicy(order({ deliveredAt: daysBefore(9), items: [LAPTOP, CHARGER] }), NOW);
  assert.equal(p.items[0]?.return.eligible, true);
  assert.equal(p.items[1]?.return.eligible, false);
});

test("cancelled / returned orders are never returnable, with the right reason", () => {
  const cancelled = evaluateOrderPolicy(order({ status: "cancelled" }), NOW);
  const returned = evaluateOrderPolicy(order({ status: "returned", deliveredAt: daysBefore(2) }), NOW);
  assert.equal(cancelled.items[0]?.return.reason, "order was cancelled");
  assert.equal(returned.items[0]?.return.reason, "order was already returned");
  assert.equal(returned.items[0]?.warranty.active, false);
});

test("delivered but no delivery date (bad data) → safe answer, no crash", () => {
  const p = evaluateOrderPolicy(order({ status: "delivered", deliveredAt: null }), NOW);
  assert.equal(p.items[0]?.return.reason, "delivery date missing");
  assert.equal(p.items[0]?.warranty.reason, "delivery date missing");
  assert.equal(p.damagedOnArrival.windowOpen, false);
});

// ── warranty ────────────────────────────────────────────────────────────

test("O010: laptop delivered 240 days ago → not returnable, 12-month warranty active", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O010", deliveredAt: daysBefore(240), items: [LAPTOP] }), NOW);
  assert.equal(p.items[0]?.return.eligible, false);
  assert.equal(p.items[0]?.warranty.active, true);
});

test("warranty expired after 12 months", () => {
  const w = evaluateOrderPolicy(order({ deliveredAt: daysBefore(400), items: [LAPTOP] }), NOW).items[0]?.warranty;
  assert.equal(w?.active, false);
  assert.match(w?.reason ?? "", /expired/);
});

test("addMonths clamps to the end of the month", () => {
  assert.equal(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(addMonths(new Date("2026-03-15T08:00:00Z"), 6).toISOString(), "2026-09-15T08:00:00.000Z");
  assert.equal(addMonths(new Date("2026-08-31T00:00:00Z"), 6).toISOString(), "2027-02-28T00:00:00.000Z");
});

// ── damaged on arrival ──────────────────────────────────────────────────

test("O033: delivered 1 day ago → damaged-on-arrival window open (48 h)", () => {
  const p = evaluateOrderPolicy(order({ orderId: "O033", deliveredAt: daysBefore(1) }), NOW);
  assert.equal(p.damagedOnArrival.windowOpen, true);
});

test("damaged-on-arrival boundary: 48 h open, 49 h closed, not delivered closed", () => {
  assert.equal(evaluateOrderPolicy(order({ deliveredAt: hoursBefore(48) }), NOW).damagedOnArrival.windowOpen, true);
  assert.equal(evaluateOrderPolicy(order({ deliveredAt: hoursBefore(49) }), NOW).damagedOnArrival.windowOpen, false);
  assert.equal(evaluateOrderPolicy(order({ status: "shipped", shippedAt: daysBefore(1) }), NOW).damagedOnArrival.windowOpen, false);
});

test("pure: same input + same now → same output", () => {
  const input = order({ deliveredAt: daysBefore(3), items: [PHONE, CHARGER] });
  assert.deepEqual(evaluateOrderPolicy(input, NOW), evaluateOrderPolicy(input, NOW));
});


//Script to run the tests
// npx tsx --env-file=.env evals/support-agent/order-policy.test.ts