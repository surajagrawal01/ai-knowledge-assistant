// Build guide steps 4, 6, 7: call the tools WITHOUT any AI.
// If a tool is buggy you want to know before an LLM is involved, or you'll blame the prompt for a SQL bug.
//   npm run try:tools-direct        (needs a seeded DB; re-seed first, seed dates are relative)
import { prisma } from "../../src/core/prisma.js";
import type { ToolCall } from "../../src/core/llm.js";
import { executeTool, READ_TOOLS, type ToolContext } from "../../src/modules/support-agent/index.js";

const ctx: ToolContext = { runId: "manual", now: new Date(), customerId: null, writesApproved: false };
// Triage-style context: the message came from C002, so other customers' orders are off limits.
const ctxAsC002: ToolContext = { ...ctx, customerId: "C002" };

type Case = { label: string; call: ToolCall; ctx?: ToolContext };
const call = (name: string, args: unknown): ToolCall => ({ id: null, name, args });

const CASES: Case[] = [
  // Step 4: the first two tools, success + error shapes
  { label: "getCustomer C001 → profile", call: call("getCustomer", { customerId: "C001" }) },
  { label: "getCustomer C999 → NOT_FOUND object, no throw", call: call("getCustomer", { customerId: "C999" }) },
  { label: "getCustomer 123 → INVALID_ARGS, run never called", call: call("getCustomer", { customerId: 123 }) },
  // { label: "getOrder o020 (lowercase) → shipped, zone B", call: call("getOrder", { orderId: "o020" }) },
  // { label: "getOrder O033 as C002 → OWNERSHIP_MISMATCH", call: call("getOrder", { orderId: "O033" }), ctx: ctxAsC002 },
  // // Step 6: the other five tools
  // { label: "checkOrderPolicy O020 → delayed", call: call("checkOrderPolicy", { orderId: "O020" }) },
  // { label: "checkOrderPolicy O028 → not returnable, warranty active", call: call("checkOrderPolicy", { orderId: "O028" }) },
  // { label: "getCustomerOrders C003 → 6 orders, showing 5", call: call("getCustomerOrders", { customerId: "C003", limit: null }) },
  // { label: "getCustomerOrders C999 → NOT_FOUND", call: call("getCustomerOrders", { customerId: "C999", limit: null }) },
  // { label: "getPayment O030 → failed UPI", call: call("getPayment", { orderId: "O030" }) },
  { label: "getPayment O035 → alreadyRefunded", call: call("getPayment", { orderId: "O035" }) },
  // { label: "getCustomerTickets C004 open → T004", call: call("getCustomerTickets", { customerId: "C004", status: "open" }) },
  // { label: "findCustomers name Rahul → C002 + C018", call: call("findCustomers", { email: null, phone: null, name: "Rahul" }) },
  // { label: "findCustomers by email (log shows it redacted)", call: call("findCustomers", { email: "Priya.Sharma@example.in", phone: null, name: null }) },
  // { label: "findCustomers by phone digits", call: call("findCustomers", { email: null, phone: "9960013389", name: null }) },
  // { label: "findCustomers nobody → count 0 (success)", call: call("findCustomers", { email: "nobody@example.in", phone: null, name: null }) },
  // // Step 7: the executor's own errors
  // { label: "unknown tool → UNKNOWN_TOOL", call: call("deleteAllTickets", {}) },
  // { label: "prototype key → UNKNOWN_TOOL", call: call("constructor", {}) },
  // { label: "getOrder {} → INVALID_ARGS", call: call("getOrder", {}) },
  // { label: "findCustomers all null → INVALID_ARGS", call: call("findCustomers", { email: null, phone: null, name: null }) },
];

for (const c of CASES) {
  console.log(`\n▶ ${c.label}`);
  const execution = await executeTool(c.call, READ_TOOLS, c.ctx ?? ctx);
  console.dir(execution.result, { depth: null });
}

await prisma.$disconnect();

// # Run the script To Test
//  npx tsx--env - file=.env scripts / support - agent /try-tools - direct.ts