// Build guide step 9: ONE round of tool calling, with every message printed.
//   npm run try:tools                                    → "Show me C003's recent orders"
//   npm run try:tools -- "Is O028 returnable?"           → your own question
// B2 puts exactly this inside a loop. Here it stops after one round on purpose.
import { addUsage, generateWithTools, type ChatMessage } from "../../src/core/llm.js";
import { prisma } from "../../src/core/prisma.js";
import {
  AGENT_SYSTEM_PROMPT,
  executeToolCalls,
  READ_TOOLS,
  toolResultsMessage,
  toToolSpecs,
  userMessage,
  type ToolContext,
} from "../../src/modules/support-agent/index.js";

const question = process.argv.slice(2).join(" ").trim() || "Show me C003's recent orders";
const ctx: ToolContext = { runId: `try_${Date.now()}`, now: new Date(), customerId: null, writesApproved: false };
const tools = toToolSpecs(READ_TOOLS);

// `raw` is the provider's opaque turn: hidden here only to keep the printout readable.
function printHistory(history: ChatMessage[]): void {
  const readable = history.map((m) => (m.role === "assistant" ? { ...m, raw: m.raw ? "<model turn, sent back unchanged>" : null } : m));
  console.log(JSON.stringify(readable, null, 2));
}

// 1. The history starts with the question. The system prompt is NOT in it.
const history: ChatMessage[] = [userMessage(question)];
console.log(`▶ ${question} - here`);

// 2. First model call: text, or tool calls?
const first = await generateWithTools({ system: AGENT_SYSTEM_PROMPT, messages: history, tools });
console.log("🚀 ~ first:", first)
let usage = first.usage;

if (first.toolCalls.length === 0) {
  // 3a. The model answered directly: no tool needed (e.g. an off-topic question).
  console.log(`\n[call 1] text (no tools): ${first.text}`);
} else {
  // 3. The model DECIDED. Look at exactly what it asked for, before your code runs anything.
  for (const c of first.toolCalls) console.log(`[call 1] tool call: ${c.name} ${JSON.stringify(c.args)}`);

  // 4. Push the model's turn AS RETURNED (raw keeps the thought signatures).
  history.push(first.assistantMessage);

  console.log("\n── history sent on call 1 ──");

  // 5. YOUR CODE executes: validate → allow → run → shape → log. Never throws.
  const executions = await executeToolCalls(first.toolCalls, READ_TOOLS, ctx);
  console.log("🚀 ~ executions:", executions)
  for (const e of executions) console.log(`[tool]   ${e.name} ${e.ok ? "ok" : `✗ ${e.errorCode}`} ${e.ms}ms`);

  // 6. ONE tool message with ALL results, same order as the calls (errors included).
  history.push(toolResultsMessage(executions));

  console.log("\n── history sent on call 2 ──");
  printHistory(history);

  // 7. Second model call: it now answers FROM your tool results.
  const second = await generateWithTools({ system: AGENT_SYSTEM_PROMPT, messages: history, tools });
  console.log("🚀 ~ second:", second)
  usage = addUsage(usage, second.usage);

  if (second.toolCalls.length > 0) {
    // One round is all B1 does. Questions like "Why hasn't C002's latest order arrived?" need more: that's B2.
    console.log(`\n[call 2] the model wants MORE tools: ${second.toolCalls.map((c) => c.name).join(", ")}`);
    console.log("         → one round isn't enough for this question. That's what the agent loop (B2) solves.");
  } else {
    console.log(`\n[call 2] text: ${second.text}`);
  }
}

const calls = first.toolCalls.length === 0 ? 1 : 2;
console.log(`\ntokens: in=${usage.inputTokens} out=${usage.outputTokens} (${calls} model call${calls > 1 ? "s" : ""})`);

await prisma.$disconnect();

// # Uses the default question: "Show me C003's recent orders"
// npx tsx --env-file=.env scripts/support-agent/try-tools.ts

// # Or ask your own question
// npx tsx --env-file=.env scripts/support-agent/try-tools.ts "Is O028 returnable?"
