// npm run eval:triage                     → all 14 cases (needs the API key AND the seeded DB: re-seed first, dates drift)
// npm run eval:triage -- --only TR01,TR13 → a subset (not judged against the bar)
// npm run eval:triage -- --pause 45000    → Gemini FREE TIER: one case is 1 extraction + 3–5 agent calls
//
// Part C's eval: the WHOLE triage, through triage() (the same path as POST /api/triage).
// Each case checks the OUTCOME (action, IDs, ticket), the TRAJECTORY (the right tools were called)
// and SAFETY (the reply doesn't leak). Nothing is written: confirm is never called.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { prisma } from "../../src/core/prisma.js";
import { TRIAGE_ACTIONS, TRIAGE_MAX_STEPS, triage, type TriageResponse } from "../../src/modules/triage/index.js";

const PASS_BAR = 12;                    // out of 14
const DEFAULT_PAUSE_MS = 1_000;
const QUOTA_RETRY_WAIT_MS = 60_000;     // a provider failure is the quota, not the agent: wait, retry once
const DEFAULT_MAX_TOOL_CALLS = 10;

const oneOrMany = <T extends z.ZodType>(s: T) => z.union([s, z.array(s)]).transform((v) => (Array.isArray(v) ? v : [v]));

// The cases file is outside input too: validate it.
const CaseSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  message: z.string().min(1),
  expect: z.object({
    action: oneOrMany(z.enum(TRIAGE_ACTIONS)),                // any of these
    customer_id: z.string().nullable().optional(),
    order_id: z.string().nullable().optional(),
    existing_ticket_id: z.string().optional(),
    verified: z.boolean().optional(),
    ticket_category: oneOrMany(z.string()).optional(),
    ticket_priority: oneOrMany(z.string()).optional(),
    must_call: z.array(z.string()).default([]),
    must_not_call: z.array(z.string()).default([]),
    max_tool_calls: z.number().int().positive().default(DEFAULT_MAX_TOOL_CALLS),
    applied_rule: z.string().optional(),                     // a substring of one appliedRules entry
    trace_must_include_error: z.string().optional(),
    reply_must_not_match: z.array(z.string()).default([]),   // case-insensitive regexes
  }),
});
type TriageCase = z.infer<typeof CaseSchema>;

const cases = z.array(CaseSchema).parse(JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")));

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").map((s) => s.trim())) : null;
const selected = only ? cases.filter((c) => only.has(c.id)) : cases;
const pauseArg = process.argv.indexOf("--pause");
const pauseMs = pauseArg >= 0 ? Number(process.argv[pauseArg + 1]) || DEFAULT_PAUSE_MS : DEFAULT_PAUSE_MS;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Pure: case + response → failures. Each failure is one readable line.
function checkCase(c: TriageCase, r: TriageResponse): string[] {
  const e = c.expect;
  const s = r.suggestion;
  const failures: string[] = [];
  const calls = r.trace.flatMap((t) => (t.type === "tool_call" ? [t] : []));
  const names = calls.map((t) => t.tool);

  if (!e.action.includes(s.action)) failures.push(`action ${s.action}, expected ${e.action.join(" | ")}`);
  if (e.customer_id !== undefined && s.customer_id !== e.customer_id) failures.push(`customer_id ${s.customer_id}, expected ${e.customer_id}`);
  if (e.order_id !== undefined && s.order_id !== e.order_id) failures.push(`order_id ${s.order_id}, expected ${e.order_id}`);
  if (e.existing_ticket_id !== undefined && s.existing_ticket_id !== e.existing_ticket_id) {
    failures.push(`existing_ticket_id ${s.existing_ticket_id}, expected ${e.existing_ticket_id}`);
  }
  if (e.verified !== undefined && s.verified !== e.verified) failures.push(`verified ${s.verified}, expected ${e.verified}`);
  if (e.ticket_category && !e.ticket_category.includes(s.proposed_ticket?.category ?? "none")) {
    failures.push(`ticket category ${s.proposed_ticket?.category ?? "none"}, expected ${e.ticket_category.join(" | ")}`);
  }
  if (e.ticket_priority && !e.ticket_priority.includes(s.proposed_ticket?.priority ?? "none")) {
    failures.push(`ticket priority ${s.proposed_ticket?.priority ?? "none"}, expected ${e.ticket_priority.join(" | ")}`);
  }

  for (const name of e.must_call) if (!names.includes(name)) failures.push(`never called ${name}`);
  for (const name of e.must_not_call) if (names.includes(name)) failures.push(`called forbidden tool ${name}`);
  const realCalls = calls.filter((t) => t.tool !== "submitTriage").length;
  if (realCalls > e.max_tool_calls) failures.push(`${realCalls} tool calls (max ${e.max_tool_calls})`);
  if (calls.some((t) => t.errorCode === "REPEATED_CALL")) failures.push("repeated an identical call");
  if (r.stats.modelCalls > TRIAGE_MAX_STEPS) failures.push(`${r.stats.modelCalls} model calls`);
  if (e.trace_must_include_error && !calls.some((t) => t.errorCode === e.trace_must_include_error)) {
    failures.push(`no ${e.trace_must_include_error} in the trace`);
  }
  if (e.applied_rule && !r.appliedRules.some((rule) => rule.includes(e.applied_rule ?? ""))) {
    failures.push(`rule "${e.applied_rule}" not applied`);
  }
  // The agent should end with a real submission; a fallback escalation passes only safety cases by luck.
  if (r.outcome !== "submitted") failures.push(`outcome ${r.outcome}`);

  for (const pattern of e.reply_must_not_match) {
    if (new RegExp(pattern, "i").test(s.reply_draft)) failures.push(`reply must NOT match /${pattern}/`);
  }
  return failures;
}

function describeTrajectory(r: TriageResponse): string {
  const calls = r.trace.flatMap((t) => (t.type === "tool_call" ? [`${t.step}:${t.tool}${t.ok ? "" : `✗${t.errorCode}`}`] : []));
  return calls.join(" → ") || "no tool calls";
}

let passed = 0;
let totals = { modelCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0, runs: 0 };

// One after another: parallel runs hit rate limits and make the timings meaningless.
for (const c of selected) {
  try {
    let r = await triage(c.message, { now: new Date() });
    if (r.outcome === "llm_error" || r.outcome === "extraction_failed") {
      console.log(`⏳ ${c.id}  ${r.outcome} (likely the rate limit): waiting ${QUOTA_RETRY_WAIT_MS / 1000}s, retrying once`);
      await sleep(QUOTA_RETRY_WAIT_MS);
      r = await triage(c.message, { now: new Date() });
    }
    const failures = checkCase(c, r);
    if (failures.length === 0) passed++;
    totals = {
      modelCalls: totals.modelCalls + r.stats.modelCalls + r.stats.extractionAttempts,
      toolCalls: totals.toolCalls + r.stats.toolCalls,
      tokensIn: totals.tokensIn + r.stats.tokens.input,
      tokensOut: totals.tokensOut + r.stats.tokens.output,
      ms: totals.ms + r.stats.ms,
      runs: totals.runs + 1,
    };
    const ticket = r.suggestion.proposed_ticket;
    console.log(`${failures.length === 0 ? "✅" : "❌"} ${c.id}  ${c.scenario}`);
    console.log(
      `     ${describeTrajectory(r)}  · ${r.suggestion.action}${ticket ? ` (${ticket.category}, ${ticket.priority})` : ""}` +
      ` · ${r.stats.modelCalls} agent calls · ${(r.stats.ms / 1000).toFixed(1)} s`,
    );
    if (r.appliedRules.length > 0) console.log(`     rules: ${r.appliedRules.join("; ")}`);
    for (const f of failures) console.log(`     ✗ ${f}`);
    if (failures.length > 0) console.log(`     reply: ${r.suggestion.reply_draft.slice(0, 200)}`);
  } catch (err) {
    console.log(`💥 ${c.id}  ${c.scenario}\n     ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(pauseMs);
}

const n = selected.length;
const avg = (x: number) => (totals.runs === 0 ? 0 : Math.round(x / totals.runs));
console.log(`\n${passed}/${n} passed`);
console.log(
  `avg per case: ${(totals.modelCalls / Math.max(totals.runs, 1)).toFixed(1)} model calls (incl. extraction) · ` +
  `${(totals.toolCalls / Math.max(totals.runs, 1)).toFixed(1)} tool calls · ` +
  `agent tokens in=${avg(totals.tokensIn)} out=${avg(totals.tokensOut)} · ${avg(totals.ms)}ms`,
);

await prisma.$disconnect();

// Only a FULL run is judged against the bar (an --only subset is an experiment).
if (!only && passed < PASS_BAR) {
  console.log(`Below the pass bar (${PASS_BAR}/${cases.length}).`);
  process.exitCode = 1;
}
