// npm run test:tools   — no DB query, no API call, no cost.
// (.env must exist because core/env.ts validates it on import, but nothing connects.)
// Tests the deterministic parts of B1: ID schemas, helpers, defineTool, the registry,
// the executor's whole pipeline (with fake tools), history building, and the
// neutral ↔ Gemini conversion in core/llm.ts. Real tools vs the DB: tools.db.test.ts.
// The model's tool choice: evals/support-agent/tool-choice/run.ts.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import {
  generateWithTools,
  readToolResponse,
  toGeminiContents,
  type ChatMessage,
  type ToolCall,
} from "../../src/core/llm.js";
import {
  buildRegistry,
  defineTool,
  executeTool,
  executeToolCalls,
  READ_TOOLS,
  toolResultsMessage,
  toToolSpecs,
  userMessage,
  type ToolContext,
  type ToolExecution,
} from "../../src/modules/support-agent/index.js";
import {
  checkOrderAccess,
  CustomerIdSchema,
  daysAgo,
  isToolError,
  OrderIdSchema,
  toInr,
  toolError,
} from "../../src/modules/support-agent/tools/common.js";
import { phoneDigits } from "../../src/modules/support-agent/tools/find-customers.tool.js";
import { formatIssues, redactArgs } from "../../src/modules/support-agent/tool-executor.js";

const NOW = new Date("2026-09-29T10:00:00Z");
const ctx: ToolContext = { runId: "test", now: NOW, customerId: null, writesApproved: false };
const call = (name: string, args: unknown, id: string | null = null): ToolCall => ({ id, name, args });

// The executor logs every call (that's the point); keep test output readable.
function quiet(t: TestContext): void {
  t.mock.method(console, "log", () => { });
  t.mock.method(console, "error", () => { });
}

// ── ID schemas ──────────────────────────────────────────────────────────

test("CustomerIdSchema normalises then checks the format", () => {
  assert.equal(CustomerIdSchema.parse("C002"), "C002");
  assert.equal(CustomerIdSchema.parse(" c002 "), "C002");
  for (const bad of ["C2", "C0002", "customer 2", "O002", 2, null, undefined]) {
    assert.equal(CustomerIdSchema.safeParse(bad).success, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("OrderIdSchema normalises then checks the format", () => {
  assert.equal(OrderIdSchema.parse("o020"), "O020");
  for (const bad of ["O20", "order 20", "C020", 20]) {
    assert.equal(OrderIdSchema.safeParse(bad).success, false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────

test("daysAgo: whole days, null passes through, future dates give 0", () => {
  assert.equal(daysAgo(new Date("2026-09-20T09:00:00Z"), NOW), 9);
  assert.equal(daysAgo(new Date("2026-09-29T09:59:00Z"), NOW), 0);
  assert.equal(daysAgo(null, NOW), null);
  assert.equal(daysAgo(new Date("2026-10-05T00:00:00Z"), NOW), 0);
});

test("toInr converts Decimal-like values and passes numbers through", () => {
  assert.equal(toInr({ toNumber: () => 4999 }), 4999);
  assert.equal(toInr(1999), 1999);
});

test("toolError / isToolError: extra fields can't overwrite error or message", () => {
  const e = toolError("NOT_FOUND", "No customer with id C999", { error: "hacked", hint: "x" });
  assert.equal(e.error, "NOT_FOUND");
  assert.equal(e.hint, "x");
  assert.equal(isToolError(e), true);
  assert.equal(isToolError({ error: "SOMETHING_ELSE", message: "x" }), false);
  assert.equal(isToolError({ orders: [] }), false);
  assert.equal(isToolError(null), false);
});

test("checkOrderAccess: not found, mismatch without details, owner ok, internal chat sees all", () => {
  const order = { id: "O033", customerId: "C007", totalInr: 34999 };
  const missing = checkOrderAccess(null, "O777", ctx);
  assert.equal(!missing.ok && missing.error.error, "NOT_FOUND");

  const mismatch = checkOrderAccess(order, "O033", { ...ctx, customerId: "C002" });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.error, "OWNERSHIP_MISMATCH");
    assert.doesNotMatch(JSON.stringify(mismatch.error), /C007|34999/);   // nothing about the other customer leaks
  }
  assert.equal(checkOrderAccess(order, "O033", { ...ctx, customerId: "C007" }).ok, true);
  assert.equal(checkOrderAccess(order, "O033", ctx).ok, true);   // customerId null = support staff
});

test("phoneDigits keeps the last 10 digits", () => {
  assert.equal(phoneDigits("+91 99600 13389"), "9960013389");
  assert.equal(phoneDigits("099600-13389"), "9960013389");
});

// ── defineTool ──────────────────────────────────────────────────────────

test("defineTool rejects bad names and empty descriptions at startup", () => {
  const args = z.object({});
  const run = async () => ({});
  assert.throws(() => defineTool({ name: "get order", description: "x", args, kind: "read", run }));
  assert.throws(() => defineTool({ name: "1tool", description: "x", args, kind: "read", run }));
  assert.throws(() => defineTool({ name: "ok", description: "  ", args, kind: "read", run }));
});

test("defineTool: JSON Schema without $schema; invalid args never reach run; valid args arrive normalised", async () => {
  let received: unknown = "never called";
  const tool = defineTool({
    name: "echoOrder",
    description: "test tool",
    args: z.object({ orderId: OrderIdSchema }),
    kind: "read",
    run: async (a) => {
      received = a;
      return { ok: true };
    },
  });
  assert.equal(tool.jsonSchema.type, "object");
  assert.equal("$schema" in tool.jsonSchema, false);

  const bad = await tool.invoke({ orderId: 20 }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(received, "never called");

  const good = await tool.invoke({ orderId: "o020" }, ctx);
  assert.equal(good.ok, true);
  assert.deepEqual(received, { orderId: "O020" });
});

// ── the real registry (shape only; no DB query) ─────────────────────────

test("READ_TOOLS: the 7 read tools, keyed by their own names", () => {
  assert.deepEqual(Object.keys(READ_TOOLS).sort(), [
    "checkOrderPolicy", "findCustomers", "getCustomer", "getCustomerOrders", "getCustomerTickets", "getOrder", "getPayment",
  ]);
  for (const [key, tool] of Object.entries(READ_TOOLS)) {
    assert.equal(key, tool.name);
    assert.equal(tool.kind, "read");
    assert.ok(tool.description.length > 40, `${key} needs a real description`);
  }
  assert.equal("createTicket" in READ_TOOLS, false);   // write tools are never given to the model
});

test("every tool's JSON Schema is an object with every parameter required (nullable, not optional)", () => {
  for (const spec of toToolSpecs(READ_TOOLS)) {
    const schema = z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()) })
      .parse(spec.parametersJsonSchema);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${spec.name}: all keys required`);
  }
});

test("buildRegistry refuses duplicate names", () => {
  const tool = defineTool({ name: "dup", description: "test", args: z.object({}), kind: "read", run: async () => ({}) });
  assert.throws(() => buildRegistry([tool, tool]), /Duplicate/);
});

test("real tools reject bad args before touching the DB", async () => {
  const cases: [string, unknown][] = [
    ["findCustomers", { email: null, phone: null, name: null }],   // refine: at least one
    ["findCustomers", { email: "not-an-email", phone: null, name: null }],
    ["findCustomers", { email: null, phone: "123", name: null }],   // < 7 digits
    ["findCustomers", { email: "a@b.in" }],                          // nullable ≠ optional: phone/name missing
    ["getCustomerOrders", { customerId: "C003", limit: 0 }],
    ["getCustomerOrders", { customerId: "C003", limit: 11 }],
    ["getCustomerOrders", { customerId: "C003", limit: 2.5 }],
    ["getCustomerTickets", { customerId: "C004", status: "pending" }],
    ["getOrder", {}],
    ["getPayment", { orderId: "PAY030" }],
  ];
  for (const [name, args] of cases) {
    const outcome = await READ_TOOLS[name]?.invoke(args, ctx);
    assert.equal(outcome?.ok, false, `${name} ${JSON.stringify(args)} should be invalid`);
  }
});

// ── executor (fake tools, so every branch is reachable) ─────────────────

const SECRET = "connect ECONNREFUSED db.internal:5432 password=hunter2";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let writeRan = false;

const FAKE_TOOLS = buildRegistry([
  defineTool({
    name: "lookup",
    description: "test",
    args: z.object({ id: CustomerIdSchema }),
    kind: "read",
    run: async ({ id }) => (id === "C999" ? toolError("NOT_FOUND", `No customer with id ${id}`) : { id, name: "Test" }),
  }),
  defineTool({ name: "explode", description: "test", args: z.object({}), kind: "read", run: async () => { throw new Error(SECRET); } }),
  defineTool({ name: "slow", description: "test", args: z.object({}), kind: "read", run: async () => { await sleep(200); return { done: true }; } }),
  defineTool({ name: "huge", description: "test", args: z.object({}), kind: "read", run: async () => ({ text: "x".repeat(9_000) }) }),
  defineTool({ name: "bigint", description: "test", args: z.object({}), kind: "read", run: async () => ({ n: 1n }) }),
  defineTool({ name: "wait", description: "test", args: z.object({ ms: z.number() }), kind: "read", run: async ({ ms }) => { await sleep(ms); return { waited: ms }; } }),
  defineTool({ name: "writeThing", description: "test", args: z.object({}), kind: "write", run: async () => { writeRan = true; return {}; } }),
]);

test("executor: success → ok, no error code, call id echoed", async (t) => {
  quiet(t);
  const e = await executeTool(call("lookup", { id: "c001" }, "call-1"), FAKE_TOOLS, ctx);
  assert.equal(e.ok, true);
  assert.equal(e.errorCode, null);
  assert.equal(e.callId, "call-1");
  assert.deepEqual(e.result, { id: "C001", name: "Test" });
});

test("executor: a tool's own error object → ok false with its code", async (t) => {
  quiet(t);
  const e = await executeTool(call("lookup", { id: "C999" }), FAKE_TOOLS, ctx);
  assert.equal(e.ok, false);
  assert.equal(e.errorCode, "NOT_FOUND");
});

test("executor: unknown tool, including prototype keys → UNKNOWN_TOOL listing what exists", async (t) => {
  quiet(t);
  for (const name of ["deleteAllTickets", "constructor", "__proto__", "toString", ""]) {
    const e = await executeTool(call(name, {}), FAKE_TOOLS, ctx);
    assert.equal(e.errorCode, "UNKNOWN_TOOL", `"${name}"`);
  }
  const e = await executeTool(call("deleteAllTickets", {}), FAKE_TOOLS, ctx);
  assert.match(String(e.result.message), /Available: lookup/);
});

test("executor: write tool without approval → NOT_ALLOWED, and it never runs", async (t) => {
  quiet(t);
  writeRan = false;
  const e = await executeTool(call("writeThing", {}), FAKE_TOOLS, ctx);
  assert.equal(e.errorCode, "NOT_ALLOWED");
  assert.equal(writeRan, false);
});

test("executor: bad args → INVALID_ARGS with a readable field path", async (t) => {
  quiet(t);
  const e = await executeTool(call("lookup", { id: 123 }), FAKE_TOOLS, ctx);
  assert.equal(e.errorCode, "INVALID_ARGS");
  assert.match(String(e.result.message), /^id: /);
  const missing = await executeTool(call("lookup", undefined), FAKE_TOOLS, ctx);
  assert.equal(missing.errorCode, "INVALID_ARGS");
});

test("executor: a thrown error → TOOL_FAILED, and the real error never reaches the model", async (t) => {
  quiet(t);
  const e = await executeTool(call("explode", {}), FAKE_TOOLS, ctx);
  assert.equal(e.errorCode, "TOOL_FAILED");
  assert.doesNotMatch(JSON.stringify(e.result), /ECONNREFUSED|hunter2|db\.internal/);
});

test("executor: a slow tool → TOOL_FAILED after the timeout", async (t) => {
  quiet(t);
  const started = Date.now();
  const e = await executeTool(call("slow", {}), FAKE_TOOLS, ctx, { timeoutMs: 20 });
  assert.equal(e.errorCode, "TOOL_FAILED");
  assert.ok(Date.now() - started < 150, "should not wait for the slow tool");
});

test("executor: oversized result → RESULT_TOO_LARGE; unserialisable result → TOOL_FAILED", async (t) => {
  quiet(t);
  assert.equal((await executeTool(call("huge", {}), FAKE_TOOLS, ctx)).errorCode, "RESULT_TOO_LARGE");
  assert.equal((await executeTool(call("bigint", {}), FAKE_TOOLS, ctx)).errorCode, "TOOL_FAILED");
});

test("executor: logs one JSON line per call, with PII redacted", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: unknown) => lines.push(String(line)));
  await executeTool(call("lookup", { id: "C001", email: "priya.sharma@example.in" }), FAKE_TOOLS, ctx);
  assert.equal(lines.length, 1);
  const logged: unknown = JSON.parse(lines[0] ?? "{}");
  assert.match(JSON.stringify(logged), /"tool":"lookup"/);
  assert.doesNotMatch(JSON.stringify(logged), /priya\.sharma/);
  assert.doesNotMatch(JSON.stringify(logged), /"name":"Test"/);   // the result body is never logged
});

test("executeToolCalls: parallel, and results stay in CALL order", async (t) => {
  quiet(t);
  const started = Date.now();
  const results = await executeToolCalls(
    [call("wait", { ms: 80 }, "a"), call("wait", { ms: 10 }, "b"), call("nope", {}, "c")],
    FAKE_TOOLS,
    ctx,
  );
  assert.deepEqual(results.map((r) => r.callId), ["a", "b", "c"]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  assert.ok(Date.now() - started < 150, "reads should run together, not one after another");
});

test("formatIssues: 'path: message' lines", () => {
  const r = z.object({ orderId: OrderIdSchema, limit: z.number().max(10) }).safeParse({ orderId: "x", limit: 99 });
  assert.equal(r.success, false);
  if (!r.success) {
    const text = formatIssues(r.error.issues);
    assert.match(text, /orderId: must look like O020/);
    assert.match(text, /limit: /);
  }
});

test("redactArgs masks email, phone and name; keeps IDs", () => {
  assert.deepEqual(redactArgs({ email: "priya.sharma@example.in", phone: "+91 99600 13389", name: "Rahul", customerId: "C002" }), {
    email: "p***@example.in",
    phone: "***89",
    name: "R***",
    customerId: "C002",
  });
  assert.equal(redactArgs("raw"), "raw");
  assert.equal(redactArgs(null), null);
});

// ── history ─────────────────────────────────────────────────────────────

test("userMessage trims and refuses empty text", () => {
  assert.deepEqual(userMessage("  hi  "), { role: "user", text: "hi" });
  assert.throws(() => userMessage("   "));
});

test("toolResultsMessage: one result per execution, same order, errors included", () => {
  const executions: ToolExecution[] = [
    { callId: "1", name: "getOrder", args: {}, result: { id: "O020" }, ok: true, errorCode: null, ms: 3 },
    { callId: null, name: "getCustomer", args: {}, result: toolError("NOT_FOUND", "No customer with id C999"), ok: false, errorCode: "NOT_FOUND", ms: 2 },
  ];
  const msg = toolResultsMessage(executions);
  assert.equal(msg.role, "tool");
  assert.deepEqual(msg.results.map((r) => [r.callId, r.name]), [["1", "getOrder"], [null, "getCustomer"]]);
  assert.equal(msg.results[1]?.result.error, "NOT_FOUND");
  assert.throws(() => toolResultsMessage([]));
});

// ── core/llm.ts: neutral history ↔ Gemini (no network) ──────────────────

test("toGeminiContents: user → text, assistant → raw UNCHANGED, tool → user functionResponse parts in order", () => {
  const raw = { role: "model", parts: [{ functionCall: { id: "x1", name: "getOrder", args: { orderId: "O020" } }, thoughtSignature: "sig" }] };
  const history: ChatMessage[] = [
    { role: "user", text: "Why hasn't O020 arrived?" },
    { role: "assistant", text: null, toolCalls: [{ id: "x1", name: "getOrder", args: { orderId: "O020" } }], raw },
    { role: "tool", results: [{ callId: "x1", name: "getOrder", result: { status: "shipped" } }, { callId: null, name: "getPayment", result: { latestStatus: "paid" } }] },
  ];
  const contents = toGeminiContents(history);
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "Why hasn't O020 arrived?" }] });
  assert.equal(contents[1], raw);   // same object: thought signatures survive
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [
      { functionResponse: { id: "x1", name: "getOrder", response: { status: "shipped" } } },
      { functionResponse: { name: "getPayment", response: { latestStatus: "paid" } } },   // no id when null
    ],
  });
});

test("toGeminiContents: an assistant turn without raw is rebuilt as a model turn", () => {
  const contents = toGeminiContents([
    { role: "user", text: "q" },
    { role: "assistant", text: "Earlier answer", toolCalls: [{ id: null, name: "getOrder", args: { orderId: "O020" } }], raw: null },
    { role: "user", text: "follow-up" },
  ]);
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [{ text: "Earlier answer" }, { functionCall: { name: "getOrder", args: { orderId: "O020" } } }],
  });
});

test("readToolResponse: calls + text, thoughts excluded, defaults for missing fields", () => {
  const content = {
    role: "model",
    parts: [
      { text: "thinking about it", thought: true },
      { text: "Let me check." },
      { functionCall: { id: "c1", name: "getCustomerOrders", args: { customerId: "C003", limit: null } } },
      { functionCall: { name: "getPayment" } },
    ],
  };
  const r = readToolResponse({ candidates: [{ content, finishReason: "STOP" }] });
  assert.equal(r.text, "Let me check.");
  assert.deepEqual(r.toolCalls, [
    { id: "c1", name: "getCustomerOrders", args: { customerId: "C003", limit: null } },
    { id: null, name: "getPayment", args: {} },
  ]);
  assert.equal(r.raw, content);
  assert.equal(r.finishReason, "STOP");
});

test("readToolResponse: text-only answer = the stop signal; empty response is safe", () => {
  const done = readToolResponse({ candidates: [{ content: { role: "model", parts: [{ text: "Ananya has 6 orders." }] } }] });
  assert.equal(done.text, "Ananya has 6 orders.");
  assert.deepEqual(done.toolCalls, []);
  const empty = readToolResponse({});
  assert.deepEqual(empty, { text: null, toolCalls: [], raw: null, finishReason: null });
});

test("generateWithTools refuses a bad request before any network call", async () => {
  const tools = toToolSpecs(READ_TOOLS);
  await assert.rejects(generateWithTools({ system: "s", messages: [], tools }), /must end with a user or tool message/);
  await assert.rejects(
    generateWithTools({ system: "s", messages: [{ role: "assistant", text: "hi", toolCalls: [], raw: null }], tools }),
    /must end with a user or tool message/,
  );
  await assert.rejects(generateWithTools({ system: "s", messages: [userMessage("q")], tools: [], mode: "any" }), /at least one tool/);
  await assert.rejects(
    generateWithTools({ system: "s", messages: [userMessage("q")], tools, allowedTools: ["getOrder"] }),
    /only works with mode 'any'/,
  );
});



//Script to run the test
// npx tsx --env-file=.env evals/support-agent/offline.test.ts