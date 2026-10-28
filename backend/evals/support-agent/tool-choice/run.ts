// npm run eval:tools                 → all cases (needs the API key AND the seeded DB)
// npm run eval:tools -- --only T02,T09   → a subset (for break-it experiments; not judged against the bar)
//
// B1's eval: ONE round of tool calling per question. It checks the TRAJECTORY (did the model pick
// the right tool with the right args?) and the OUTCOME (does the answer built from the result say
// the right thing?). The agent loop's evals (several rounds) come in B2.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { addUsage, generateWithTools, ZERO_USAGE, type ChatMessage, type ToolCall, type Usage } from "../../../src/core/llm.js";
import { prisma } from "../../../src/core/prisma.js";
import {
  AGENT_SYSTEM_PROMPT,
  executeToolCalls,
  READ_TOOLS,
  toolResultsMessage,
  toToolSpecs,
  userMessage,
  type ToolContext,
} from "../../../src/modules/support-agent/index.js";

const PASS_BAR = 9;              // out of 11
const PAUSE_BETWEEN_CASES_MS = 500;   // rate limits

// The cases file is outside input too: validate it (rule 17).
const CaseSchema = z.object({
  id: z.string(),
  question: z.string().min(1),
  expectCalls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })).optional(),
  expectNoCalls: z.boolean().optional(),
  allowInstead: z.array(z.string()).optional(),   // acceptable alternative tools (e.g. getOrder instead of checkOrderPolicy)
  neverCall: z.array(z.string()).optional(),
  answerMustMatch: z.array(z.string()).optional(),    // case-insensitive regexes
  answerMustNotMatch: z.array(z.string()).optional(),
});
type Case = z.infer<typeof CaseSchema>;

const cases = z.array(CaseSchema).parse(JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")));

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").map((s) => s.trim())) : null;
const selected = only ? cases.filter((c) => only.has(c.id)) : cases;

const tools = toToolSpecs(READ_TOOLS);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// "C003" matches "c003" and " C003 ": the executor normalises IDs, so the eval does too.
function sameValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function argsMatch(expected: Record<string, unknown> | undefined, actual: unknown): boolean {
  if (!expected) return true;
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(([key, value]) => key in actual && sameValue(value, Reflect.get(actual, key)));
}

function checkCalls(c: Case, calls: ToolCall[]): string[] {
  const failures: string[] = [];
  const names = calls.map((x) => x.name);
  const allowed = new Set(c.allowInstead ?? []);

  for (const name of c.neverCall ?? []) {
    if (names.includes(name)) failures.push(`called forbidden tool ${name}`);
  }
  if (c.expectNoCalls && calls.some((x) => !allowed.has(x.name))) {
    failures.push(`expected no tool calls, got ${names.join(", ")}`);
  }
  for (const exp of c.expectCalls ?? []) {
    const hit = calls.some((x) => x.name === exp.name && argsMatch(exp.args, x.args));
    const alternative = calls.some((x) => allowed.has(x.name));
    if (!hit && !alternative) {
      failures.push(`expected ${exp.name}(${JSON.stringify(exp.args ?? {})}), got ${calls.map((x) => `${x.name}(${JSON.stringify(x.args)})`).join(", ") || "no calls"}`);
    }
  }
  return failures;
}

function checkAnswer(c: Case, answer: string | null): string[] {
  const failures: string[] = [];
  const wantsAnswer = (c.answerMustMatch?.length ?? 0) > 0;
  if (answer === null) {
    if (wantsAnswer) failures.push("no text answer after one round (the model wanted more tools: B2 territory)");
    return failures;
  }
  for (const pattern of c.answerMustMatch ?? []) {
    if (!new RegExp(pattern, "i").test(answer)) failures.push(`answer should match /${pattern}/`);
  }
  for (const pattern of c.answerMustNotMatch ?? []) {
    if (new RegExp(pattern, "i").test(answer)) failures.push(`answer must NOT match /${pattern}/`);
  }
  return failures;
}

type CaseResult = { pass: boolean; failures: string[]; usage: Usage; ms: number; calls: ToolCall[]; answer: string | null };

async function runCase(c: Case): Promise<CaseResult> {
  const started = Date.now();
  const ctx: ToolContext = { runId: `eval_${c.id}`, now: new Date(), customerId: null, writesApproved: false };
  const history: ChatMessage[] = [userMessage(c.question)];

  const first = await generateWithTools({ system: AGENT_SYSTEM_PROMPT, messages: history, tools });
  let usage = first.usage;
  let answer = first.text;

  if (first.toolCalls.length > 0) {
    history.push(first.assistantMessage);
    history.push(toolResultsMessage(await executeToolCalls(first.toolCalls, READ_TOOLS, ctx)));
    const second = await generateWithTools({ system: AGENT_SYSTEM_PROMPT, messages: history, tools });
    usage = addUsage(usage, second.usage);
    answer = second.toolCalls.length === 0 ? second.text : null;
  }

  const failures = [...checkCalls(c, first.toolCalls), ...checkAnswer(c, answer)];
  return { pass: failures.length === 0, failures, usage, ms: Date.now() - started, calls: first.toolCalls, answer };
}

let passed = 0;
let totalUsage = ZERO_USAGE;
let totalMs = 0;

for (const c of selected) {
  try {
    const r = await runCase(c);
    totalUsage = addUsage(totalUsage, r.usage);
    totalMs += r.ms;
    if (r.pass) passed++;
    const calls = r.calls.map((x) => `${x.name}(${JSON.stringify(x.args)})`).join(", ") || "no calls";
    console.log(`${r.pass ? "✅" : "❌"} ${c.id}  ${c.question}\n     calls: ${calls}`);
    for (const f of r.failures) console.log(`     ✗ ${f}`);
    if (!r.pass && r.answer) console.log(`     answer: ${r.answer.slice(0, 200)}`);
  } catch (err) {
    console.log(`💥 ${c.id}  ${c.question}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(PAUSE_BETWEEN_CASES_MS);
}

const n = selected.length;
console.log(`\nPassed ${passed}/${n}`);
if (n > 0) {
  console.log(
    `avg per question: ${Math.round(totalMs / n)} ms, ${Math.round(totalUsage.inputTokens / n)} input tokens, ${Math.round(totalUsage.outputTokens / n)} output tokens`,
  );
}

await prisma.$disconnect();

// Only a FULL run is judged against the bar (a --only subset is an experiment).
if (!only && passed < PASS_BAR) {
  console.log(`Below the pass bar (${PASS_BAR}/${cases.length}).`);
  process.exitCode = 1;
}


//Run the script To Test
// npx tsx --env-file=.env evals/support-agent/tool-choice/run.ts