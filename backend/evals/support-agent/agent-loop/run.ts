// npm run eval:agent                     → all cases (needs the API key AND the seeded DB: re-seed first, dates drift)
// npm run eval:agent -- --only A01,A07   → a subset (for break-it experiments; not judged against the bar)
// npm run eval:agent -- --pause 45000    → Gemini FREE TIER (5 requests/min): one case is 3–4 model calls,
//                                           so wait ~45 s between cases (a full run then takes ~9 min)
//
// B2's eval: the WHOLE loop, through chat() (the same path as POST /api/agent/chat, prompt included).
// Each case checks the OUTCOME (does the answer say the right thing?) and the TRAJECTORY (did it
// get there by calling the right tools?). An answer can look right for the wrong reason, e.g.
// "delayed" guessed without calling checkOrderPolicy: only the trajectory check catches that.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { prisma } from "../../../src/core/prisma.js";
import { chat, DEFAULT_MAX_STEPS, type ChatResponse } from "../../../src/modules/support-agent/index.js";

const PASS_BAR = 9;                     // out of 11
const DEFAULT_PAUSE_MS = 1_000;         // between cases; raise it with --pause on a rate-limited key
const QUOTA_RETRY_WAIT_MS = 60_000;     // an llm_error is the provider's quota, not the agent: wait a minute, retry once
const DEFAULT_MAX_TOOL_CALLS = 8;

const OUTCOMES = ["answered", "max_steps", "timeout", "tool_failure", "llm_error", "empty_response"] as const;

// The cases file is outside input too: validate it.
const CaseSchema = z.object({
  id: z.string(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1) })).min(1),
  expectOutcome: z.enum(OUTCOMES).default("answered"),
  mustCall: z.array(z.string()).default([]),       // every one of these must appear in the trace
  anyOf: z.array(z.string()).optional(),           // at least one of these
  mustNotCall: z.array(z.string()).default([]),
  maxToolCalls: z.number().int().positive().default(DEFAULT_MAX_TOOL_CALLS),
  answerMustMatch: z.array(z.string()).default([]),     // case-insensitive regexes
  answerMustNotMatch: z.array(z.string()).default([]),
});
type AgentCase = z.infer<typeof CaseSchema>;

const cases = z.array(CaseSchema).parse(JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")));

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").map((s) => s.trim())) : null;
const selected = only ? cases.filter((c) => only.has(c.id)) : cases;
const pauseArg = process.argv.indexOf("--pause");
const pauseMs = pauseArg >= 0 ? Number(process.argv[pauseArg + 1]) || DEFAULT_PAUSE_MS : DEFAULT_PAUSE_MS;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Pure: case + response → failures. Each failure is one readable line.
function checkCase(c: AgentCase, response: ChatResponse): string[] {
  const failures: string[] = [];
  const calls = response.trace.flatMap((s) => (s.type === "tool_call" ? [s] : []));
  const names = calls.map((s) => s.tool);

  if (response.outcome !== c.expectOutcome) failures.push(`outcome ${response.outcome}, expected ${c.expectOutcome}`);
  for (const name of c.mustCall) if (!names.includes(name)) failures.push(`never called ${name}`);
  if (c.anyOf && !c.anyOf.some((name) => names.includes(name))) failures.push(`called none of ${c.anyOf.join(", ")}`);
  for (const name of c.mustNotCall) if (names.includes(name)) failures.push(`called forbidden tool ${name}`);
  if (calls.length > c.maxToolCalls) failures.push(`${calls.length} tool calls (max ${c.maxToolCalls})`);
  // In every case: a repeat means the model ignored an earlier result, and steps stay within the default.
  if (calls.some((s) => s.errorCode === "REPEATED_CALL")) failures.push("repeated an identical call");
  if (response.stats.modelCalls > DEFAULT_MAX_STEPS) failures.push(`${response.stats.modelCalls} model calls`);

  const answer = response.answer ?? "";
  for (const pattern of c.answerMustMatch) {
    if (!new RegExp(pattern, "i").test(answer)) failures.push(`answer should match /${pattern}/`);
  }
  for (const pattern of c.answerMustNotMatch) {
    if (new RegExp(pattern, "i").test(answer)) failures.push(`answer must NOT match /${pattern}/`);
  }
  return failures;
}

function describeTrajectory(response: ChatResponse): string {
  const calls = response.trace.flatMap((s) => (s.type === "tool_call" ? [`${s.step}:${s.tool}${s.ok ? "" : `✗${s.errorCode}`}`] : []));
  return calls.join(" → ") || "no tool calls";
}

let passed = 0;
let totals = { modelCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0, runs: 0 };

// One after another: parallel runs hit rate limits and make the timings meaningless.
for (const c of selected) {
  const question = c.messages.at(-1)?.text ?? "";
  try {
    let response = await chat(c.messages, { now: new Date() });
    if (response.outcome === "llm_error" && c.expectOutcome !== "llm_error") {
      console.log(`⏳ ${c.id}  llm_error (likely the rate limit): waiting ${QUOTA_RETRY_WAIT_MS / 1000}s, retrying once`);
      await sleep(QUOTA_RETRY_WAIT_MS);
      response = await chat(c.messages, { now: new Date() });
    }
    const failures = checkCase(c, response);
    if (failures.length === 0) passed++;
    totals = {
      modelCalls: totals.modelCalls + response.stats.modelCalls,
      toolCalls: totals.toolCalls + response.stats.toolCalls,
      tokensIn: totals.tokensIn + response.stats.tokens.input,
      tokensOut: totals.tokensOut + response.stats.tokens.output,
      ms: totals.ms + response.stats.ms,
      runs: totals.runs + 1,
    };
    console.log(`${failures.length === 0 ? "✅" : "❌"} ${c.id}  ${question}`);
    console.log(`     ${describeTrajectory(response)}  · ${response.outcome} · ${response.stats.modelCalls} model calls`);
    for (const f of failures) console.log(`     ✗ ${f}`);
    if (failures.length > 0) console.log(`     answer: ${(response.answer ?? response.reason ?? "").slice(0, 240)}`);
  } catch (err) {
    console.log(`💥 ${c.id}  ${question}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(pauseMs);
}

const n = selected.length;
const avg = (x: number) => (totals.runs === 0 ? 0 : Math.round(x / totals.runs));
console.log(`\n${passed}/${n} passed`);
console.log(
  `avg per case: ${(totals.modelCalls / Math.max(totals.runs, 1)).toFixed(1)} model calls · ` +
  `${(totals.toolCalls / Math.max(totals.runs, 1)).toFixed(1)} tool calls · ` +
  `in=${avg(totals.tokensIn)} out=${avg(totals.tokensOut)} tokens · ${avg(totals.ms)}ms`,
);

await prisma.$disconnect();

// Only a FULL run is judged against the bar (an --only subset is an experiment).
if (!only && passed < PASS_BAR) {
  console.log(`Below the pass bar (${PASS_BAR}/${cases.length}).`);
  process.exitCode = 1;
}


//Script usage:
// npm run eval:agent                     → all cases (needs the API key AND the seeded DB: re-seed first, dates drift)
// npm run eval:agent -- --only A01,A07   → a subset (for break-it experiments; not judged against the bar)
// npm run eval:agent -- --pause 45000    → Gemini FREE TIER (5 requests/min): one case is 3–4 model calls,
//                                           so wait ~45 s between cases (a full run then takes ~9 min)