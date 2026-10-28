// npm run test:tools:db   — needs the SEEDED database (npm run db:seed first). No API key used.
// Every real tool against the planted stories, through the real executor.
// Seed dates are "N days before you seeded", so the day counts drift as days pass. These asserts
// only check facts that stay true for at least a few days after seeding; re-seed if one fails on timing.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { prisma } from "../../src/core/prisma.js";
import { executeTool, READ_TOOLS, type ToolContext } from "../../src/modules/support-agent/index.js";

const ctx: ToolContext = { runId: "db-test", now: new Date(), customerId: null, writesApproved: false };

after(async () => {
  await prisma.$disconnect();
});

async function run(name: string, args: unknown, context: ToolContext = ctx) {
  return executeTool({ id: null, name, args }, READ_TOOLS, context);
}

// Parse results with Zod in tests too: the result type is Record<string, unknown> on purpose.
const NamedList = z.object({ matches: z.array(z.object({ id: z.string(), matchedOn: z.array(z.string()) })), count: z.number() });

test("getCustomer: C001 profile without phone; C999 → NOT_FOUND", async () => {
  const ok = await run("getCustomer", { customerId: "C001" });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.name, "Priya Sharma");
  assert.equal(ok.result.tier, "premium");
  assert.equal("phone" in ok.result, false);

  const missing = await run("getCustomer", { customerId: "C999" });
  assert.equal(missing.errorCode, "NOT_FOUND");
});

test("findCustomers: Rahul matches C002 and C018; email match is exact; nobody → count 0", async () => {
  const rahul = NamedList.parse((await run("findCustomers", { email: null, phone: null, name: "rahul" })).result);
  assert.deepEqual(rahul.matches.map((m) => m.id).sort(), ["C002", "C018"]);

  const priya = NamedList.parse((await run("findCustomers", { email: "PRIYA.SHARMA@example.in", phone: null, name: null })).result);
  assert.equal(priya.count, 1);
  assert.equal(priya.matches[0]?.id, "C001");
  assert.deepEqual(priya.matches[0]?.matchedOn, ["email"]);

  const byPhone = NamedList.parse((await run("findCustomers", { email: null, phone: "99600 13389", name: null })).result);
  assert.equal(byPhone.matches[0]?.id, "C002");

  const nobody = await run("findCustomers", { email: "nobody@example.in", phone: null, name: null });
  assert.equal(nobody.ok, true);   // 0 matches is an answer, not an error
  assert.equal(nobody.result.count, 0);
});

test("getCustomerOrders: C003 has 6, default shows 5 newest; C002's latest is O020; C999 → NOT_FOUND", async () => {
  const c003 = await run("getCustomerOrders", { customerId: "C003", limit: null });
  const parsed = z.object({ totalOrders: z.number(), showing: z.number(), orders: z.array(z.object({ id: z.string() })) }).parse(c003.result);
  assert.equal(parsed.totalOrders, 6);
  assert.equal(parsed.showing, 5);
  assert.equal(parsed.orders[0]?.id, "O025");

  const c002 = await run("getCustomerOrders", { customerId: "c002", limit: 1 });
  const latest = z.object({ orders: z.array(z.object({ id: z.string(), status: z.string(), products: z.array(z.string()) })) }).parse(c002.result);
  assert.deepEqual(latest.orders[0], { ...latest.orders[0], id: "O020", status: "shipped", products: ["NestBuds Pro"] });

  assert.equal((await run("getCustomerOrders", { customerId: "C999", limit: null })).errorCode, "NOT_FOUND");
});

test("getOrder: O020 shaped (plain numbers, relative days); ownership enforced in triage context", async () => {
  const o020 = await run("getOrder", { orderId: "O020" });
  assert.equal(o020.result.status, "shipped");
  assert.equal(o020.result.zone, "B");
  assert.equal(o020.result.totalInr, 4999);   // a number, not a Decimal
  assert.equal(typeof o020.result.shippedDaysAgo, "number");

  const asC002 = await run("getOrder", { orderId: "O033" }, { ...ctx, customerId: "C002" });
  assert.equal(asC002.errorCode, "OWNERSHIP_MISMATCH");
  assert.doesNotMatch(JSON.stringify(asC002.result), /C007|34999/);

  assert.equal((await run("getOrder", { orderId: "O777" })).errorCode, "NOT_FOUND");
});

test("checkOrderPolicy: O020 delayed, O028 not returnable but under warranty, O025 returnable, O010 warranty", async () => {
  const Policy = z.object({
    delivery: z.object({ applicable: z.boolean(), delayed: z.boolean().optional() }),
    items: z.array(z.object({ return: z.object({ eligible: z.boolean() }), warranty: z.object({ active: z.boolean() }) })),
    damagedOnArrival: z.object({ windowOpen: z.boolean() }),
  });

  const o020 = Policy.parse((await run("checkOrderPolicy", { orderId: "O020" })).result);
  assert.equal(o020.delivery.delayed, true);

  const o028 = Policy.parse((await run("checkOrderPolicy", { orderId: "O028" })).result);
  assert.equal(o028.items[0]?.return.eligible, false);
  assert.equal(o028.items[0]?.warranty.active, true);

  const o025 = Policy.parse((await run("checkOrderPolicy", { orderId: "O025" })).result);
  assert.equal(o025.items[0]?.return.eligible, true, "O025 was delivered 3 days before seeding: re-seed if this fails");

  const o010 = Policy.parse((await run("checkOrderPolicy", { orderId: "O010" })).result);
  assert.equal(o010.items[0]?.return.eligible, false);
  assert.equal(o010.items[0]?.warranty.active, true);

  const o033 = Policy.parse((await run("checkOrderPolicy", { orderId: "O033" })).result);
  assert.equal(o033.damagedOnArrival.windowOpen, true, "O033 was delivered 1 day before seeding: re-seed if this fails");
});

test("getPayment: O030 failed UPI, O035 already refunded, O020 paid", async () => {
  const o030 = await run("getPayment", { orderId: "O030" });
  assert.equal(o030.result.latestStatus, "failed");
  assert.equal(o030.result.alreadyRefunded, false);

  const o035 = await run("getPayment", { orderId: "O035" });
  assert.equal(o035.result.alreadyRefunded, true);

  const o020 = await run("getPayment", { orderId: "O020" });
  assert.equal(o020.result.latestStatus, "paid");
});

test("getCustomerTickets: C004 has open T004; no descriptions are returned", async () => {
  const c004 = await run("getCustomerTickets", { customerId: "C004", status: "open" });
  const parsed = z.object({ tickets: z.array(z.record(z.string(), z.unknown())) }).parse(c004.result);
  assert.ok(parsed.tickets.some((t) => t.id === "T004"));
  for (const t of parsed.tickets) assert.equal("description" in t, false);

  const c002 = await run("getCustomerTickets", { customerId: "C002", status: "open" });
  assert.equal(c002.result.count, 0);

  assert.equal((await run("getCustomerTickets", { customerId: "C999", status: null })).errorCode, "NOT_FOUND");
});

test("every real result is small: no tool comes near MAX_RESULT_CHARS on seed data", async () => {
  const biggest = await run("getCustomerOrders", { customerId: "C003", limit: 10 });
  assert.equal(biggest.ok, true);
  assert.ok(JSON.stringify(biggest.result).length < 4_000);
});

// # Run the tests To Test
//  npx tsx --env-file=.env evals/support-agent/tools.db.test.ts