// npm run eval:extract                 → all cases
// npm run eval:extract -- --only E04,E15   → just these (handy for "break it on purpose")
//
// Scores ONLY the fields listed in each case's "expected". Arrays mean "any of these".
// Special keys: "ok" (the result's ok flag), "products_mentioned_count" (array length).
import { readFileSync } from "node:fs";
import { z } from "zod";
import { extractTicket } from "../../src/modules/ticket-extractor/ticket-extractor.service.js"
import { type ExtractResult } from "../../src/modules/ticket-extractor/ticket.schema.js";

const PASS_BAR = 17;          // from the build guide: ≥ 17/20. Never lower it to make a run pass 
const DELAY_MS = 500;         // be kind to free-tier rate limits

// The cases file is input from outside the code too: validate it
const ExpectedValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
const EvalCaseSchema = z.object({
    id: z.string(),
    type: z.string(),
    message: z.string(),
    expected: z.record(z.string(), ExpectedValue),
    tests: z.string(),
});
type EvalCase = z.infer<typeof EvalCaseSchema>;
type Expected = z.infer<typeof ExpectedValue>;

const casesPath = new URL("./eval-cases.json", import.meta.url);   // works from any cwd
const allCases = z.array(EvalCaseSchema).parse(JSON.parse(readFileSync(casesPath, "utf8")));

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > -1 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").map((s) => s.trim())) : null;
const cases = only ? allCases.filter((c) => only.has(c.id)) : allCases;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const show = (v: unknown) => JSON.stringify(v);

function matches(expected: Expected, actual: unknown): boolean {
    if (Array.isArray(expected)) return typeof actual === "string" && expected.includes(actual);
    return expected === actual;
}

function actualValue(result: ExtractResult, key: string): unknown {
    if (key === "ok") return result.ok;
    if (!result.ok) return undefined;
    if (key === "products_mentioned_count") return result.ticket.products_mentioned.length;
    const fields: Record<string, unknown> = { ...result.ticket };
    return fields[key];
}

// Returns one entry per expected field: did it pass, and a readable failure line.
function scoreCase(c: EvalCase, result: ExtractResult) {
    return Object.entries(c.expected).map(([key, expected]) => {
        const actual = actualValue(result, key);
        const pass = matches(expected, actual);
        const got = !result.ok && key !== "ok" ? `failed extraction (${result.reason})` : show(actual);
        return { key, pass, line: `${key}: expected ${show(expected)}, got ${got}` };
    });
}

const perField = new Map<string, { pass: number; total: number }>();
const failedIds: string[] = [];
let passed = 0;
let totalMs = 0;

for (const [index, c] of cases.entries()) {
    const started = Date.now();
    let result: ExtractResult;
    try {
        result = await extractTicket(c.message);
    } catch (err) {
        // A thrown error is a bug in our code (AI failures come back as ok:false). Count it, keep going.
        console.log(`💥 ${c.id} threw: ${err instanceof Error ? err.message : String(err)}`);
        failedIds.push(c.id);
        continue;
    }
    totalMs += Date.now() - started;

    const scores = scoreCase(c, result);
    for (const s of scores) {
        const f = perField.get(s.key) ?? { pass: 0, total: 0 };
        f.total++;
        if (s.pass) f.pass++;
        perField.set(s.key, f);
    }

    const failures = scores.filter((s) => !s.pass);
    if (failures.length === 0) {
        passed++;
        console.log(`✅ ${c.id} (${c.type})`);
    } else {
        failedIds.push(c.id);
        console.log(`❌ ${c.id} (${c.type}) ${failures.map((f) => f.line).join(" | ")}`);
    }
    if (result.ok && result.warnings.length > 0) console.log(`   ⚠️  ${result.warnings.join("; ")}`);

    if (index < cases.length - 1) await sleep(DELAY_MS);
}

console.log("\nPer-field accuracy");
for (const [key, f] of [...perField.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${key.padEnd(26)} ${f.pass}/${f.total}`);
}

console.log(`\nPassed ${passed}/${cases.length}   avg ${Math.round(totalMs / Math.max(cases.length, 1))} ms/case`);
if (failedIds.length > 0) console.log(`Failed: ${failedIds.join(", ")}`);

// Only the full run is judged against the bar; --only runs are experiments.
if (!only && passed < PASS_BAR) {
    console.log(`Below the pass bar (${PASS_BAR}/${allCases.length}).`);
    process.exitCode = 1;
}


//Run the script To Test
// npx tsx --env-file=.env evals/ticket-extractor/run.ts