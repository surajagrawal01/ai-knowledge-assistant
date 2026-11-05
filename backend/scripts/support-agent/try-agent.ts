// B2 build guide steps 2–5: the FULL agent loop on real data, every step printed.
//   npm run try:agent                                        → "Why hasn't C002's latest order arrived?"
//   npm run try:agent -- "Is O028 returnable?"               → your own question
//   npm run try:agent -- --max-steps 1 "..."                 → watch a limit exit (guide step 4)
//   npm run try:agent -- --history "..."                     → also print the final history (raw hidden)
// Needs the API key AND the seeded DB. Each run costs a few model calls.
import type { ChatMessage } from "../../src/core/llm.js";
import { prisma } from "../../src/core/prisma.js";
import {
  AGENT_SYSTEM_PROMPT,
  newRunId,
  READ_TOOLS,
  runAgent,
  userMessage,
  type ToolContext,
  type TraceStep,
} from "../../src/modules/support-agent/index.js";

const argv = process.argv.slice(2);
const showHistory = argv.includes("--history");
const maxStepsAt = argv.indexOf("--max-steps");
const maxSteps = maxStepsAt >= 0 ? Number(argv[maxStepsAt + 1]) : undefined;
const isFlagValue = (i: number) => maxStepsAt >= 0 && i === maxStepsAt + 1;
const question =
  argv.filter((a, i) => !a.startsWith("--") && !isFlagValue(i)).join(" ").trim() || "Why hasn't C002's latest order arrived?";

function printStep(s: TraceStep): void {
  switch (s.type) {
    case "tool_call":
      console.log(`  step ${s.step} → ${s.tool}(${JSON.stringify(s.args)})  ${s.ok ? "✓" : "✗"} ${s.summary}  ${s.ms}ms`);
      break;
    case "model_text":
      console.log(`  step ${s.step} → ${s.final ? "ANSWER" : "text"}: ${s.text}`);
      break;
    case "guardrail":
      console.log(`  step ${s.step} ⚠ guardrail ${s.kind}: ${s.detail}`);
      break;
  }
}

// `raw` is the provider's opaque turn: hidden here only to keep the printout readable.
function printHistory(history: ChatMessage[]): void {
  history.forEach((m, i) => {
    if (m.role === "user") console.log(`[${i}] user       ${JSON.stringify(m.text)}`);
    else if (m.role === "assistant") {
      const calls = m.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join(", ");
      console.log(`[${i}] assistant  ${calls ? `toolCalls: [ ${calls} ]` : `text: ${JSON.stringify(m.text)}`}${m.raw ? "  + raw" : ""}`);
    } else {
      const results = m.results.map((r) => `${r.name} → ${JSON.stringify(r.result).slice(0, 100)}…`).join("\n                ");
      console.log(`[${i}] tool       ${results}`);
    }
  });
}

const ctx: ToolContext = { runId: newRunId(), now: new Date(), customerId: null, writesApproved: false };
console.log(`▶ ${question}${maxSteps ? `   (maxSteps ${maxSteps})` : ""}\n`);

const result = await runAgent({
  messages: [userMessage(question)],
  system: AGENT_SYSTEM_PROMPT,
  tools: READ_TOOLS,
  ctx,
  ...(maxSteps !== undefined ? { maxSteps } : {}),
});

console.log("\n── trace ──");
result.run.steps.forEach(printStep);

if (showHistory) {
  console.log("\n── final history (what the model saw) ──");
  printHistory(result.messages);
}

const { run } = result;
console.log(`\noutcome: ${result.outcome}${result.ok ? "" : ` · ${result.reason}`}`);
console.log(
  `${run.modelCalls} model calls · ${run.toolCalls} tool calls · tokens in=${run.usage.inputTokens} out=${run.usage.outputTokens}` +
  ` · history ${run.finalHistorySize} chars · ${run.ms}ms · ${run.runId}`,
);

await prisma.$disconnect();

//Run the script with the following command to test the agent's response to a specific question:
// npm run try:agent -- --history "C004 wants to return their headphones. Can they, and do they already have a ticket for it?"