// Pure logic shared by the embedding eval (run.ts) and the playground script.
// No API calls in here: the embed function is passed in, so the offline tests can
// run the same code with fake vectors.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { EmbeddingTaskType } from "../../../src/core/llm.js";
import { cosineSimilarity, type Vector } from "../../../src/core/vector.js";

// ── cases.json shape (validated: a typo in an id should fail loudly, not score 0) ──

const SentenceId = z.string().regex(/^S\d{2}$/);

const SentenceSchema = z.object({
    id: SentenceId,
    group: z.string(),
    role: z.enum(["question", "statement"]),
    text: z.string().min(1),
});

const PairSchema = z.object({
    a: SentenceId,
    b: SentenceId,
    predict: z.enum(["high", "middle", "low"]),
    shows: z.string(),
});

const Mode = z.enum(["similarity", "retrieval"]);
const Base = { id: z.string(), mode: Mode, core: z.boolean(), why: z.string() };

const CheckSchema = z.discriminatedUnion("kind", [
    z.object({ ...Base, kind: z.literal("higher"), higher: z.tuple([SentenceId, SentenceId]), lower: z.tuple([SentenceId, SentenceId]) }),
    z.object({ ...Base, kind: z.literal("top_document"), query: SentenceId, expected: SentenceId }),
    z.object({ ...Base, kind: z.literal("best_match_lower"), outOfScope: SentenceId, inScope: z.array(SentenceId).min(1) }),
]);

export const CasesSchema = z.object({
    sentences: z.array(SentenceSchema).min(2),
    pairs: z.array(PairSchema),
    checks: z.array(CheckSchema),
});

export type Cases = z.infer<typeof CasesSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Mode = z.infer<typeof Mode>;

export function loadCases(url: URL = new URL("./cases.json", import.meta.url)): Cases {
    return parseCases(JSON.parse(readFileSync(url, "utf8")));
}

// Validates shape AND cross-references (every id used by a pair or check must exist).
export function parseCases(raw: unknown): Cases {
    const cases = CasesSchema.parse(raw);
    const ids = new Set(cases.sentences.map((s) => s.id));
    const referenced = [
        ...cases.pairs.flatMap((p) => [p.a, p.b]),
        ...cases.checks.flatMap((c) =>
            c.kind === "higher" ? [...c.higher, ...c.lower]
                : c.kind === "top_document" ? [c.query, c.expected]
                    : [c.outOfScope, ...c.inScope],
        ),
    ];
    const unknown = referenced.filter((id) => !ids.has(id));
    if (unknown.length) throw new Error(`cases.json references unknown sentence ids: ${[...new Set(unknown)].join(", ")}`);
    return cases;
}

// ── embedding the sentences ──

export type EmbedFn = (texts: string[], options: { taskType: EmbeddingTaskType }) => Promise<Vector[]>;
export type VectorsById = Map<string, Vector>;

// similarity mode: one call, everything SEMANTIC_SIMILARITY.
// retrieval mode: questions as RETRIEVAL_QUERY, statements as RETRIEVAL_DOCUMENT (two calls),
// exactly how Part 3 will embed questions and chunks.
export async function embedSentences(sentences: Sentence[], mode: Mode, embedFn: EmbedFn): Promise<VectorsById> {
    const byId: VectorsById = new Map();
    const run = async (group: Sentence[], taskType: EmbeddingTaskType) => {
        if (group.length === 0) return;
        const vectors = await embedFn(group.map((s) => s.text), { taskType });
        group.forEach((s, i) => byId.set(s.id, vectors[i]!));
    };
    if (mode === "similarity") {
        await run(sentences, "SEMANTIC_SIMILARITY");
    } else {
        await run(sentences.filter((s) => s.role === "question"), "RETRIEVAL_QUERY");
        await run(sentences.filter((s) => s.role === "statement"), "RETRIEVAL_DOCUMENT");
    }
    return byId;
}

export function similarity(vectors: VectorsById, a: string, b: string): number {
    const va = vectors.get(a);
    const vb = vectors.get(b);
    if (!va || !vb) throw new Error(`no vector for ${va ? b : a}`);
    return cosineSimilarity(va, vb);
}

// Best-scoring statement for a sentence (what search will return as "top 1").
export function nearestStatement(cases: Cases, vectors: VectorsById, id: string): { id: string; score: number } {
    let best = { id: "", score: -Infinity };
    for (const s of cases.sentences) {
        if (s.role !== "statement" || s.id === id) continue;
        const score = similarity(vectors, id, s.id);
        if (score > best.score) best = { id: s.id, score };
    }
    return best;
}

// ── scoring ──

export type CheckResult = {
    id: string;
    core: boolean;
    passed: boolean;
    detail: string;   // the numbers that decided it, so a failure is explainable
    why: string;
};

const f = (n: number) => n.toFixed(3);

export function runCheck(cases: Cases, check: Check, vectors: VectorsById): CheckResult {
    const base = { id: check.id, core: check.core, why: check.why };
    switch (check.kind) {
        case "higher": {
            const hi = similarity(vectors, ...check.higher);
            const lo = similarity(vectors, ...check.lower);
            return { ...base, passed: hi > lo, detail: `${check.higher.join("~")} ${f(hi)} > ${check.lower.join("~")} ${f(lo)}` };
        }
        case "top_document": {
            const top = nearestStatement(cases, vectors, check.query);
            return { ...base, passed: top.id === check.expected, detail: `top for ${check.query} = ${top.id} (${f(top.score)}), expected ${check.expected}` };
        }
        case "best_match_lower": {
            const out = nearestStatement(cases, vectors, check.outOfScope);
            const weakestInScope = Math.min(...check.inScope.map((id) => nearestStatement(cases, vectors, id).score));
            return {
                ...base,
                passed: out.score < weakestInScope,
                detail: `${check.outOfScope} best ${f(out.score)} < weakest in-scope best ${f(weakestInScope)}`,
            };
        }
    }
}

export function runChecks(cases: Cases, vectorsByMode: Record<Mode, VectorsById>): CheckResult[] {
    return cases.checks.map((check) => runCheck(cases, check, vectorsByMode[check.mode]));
}

export function summarize(results: CheckResult[]): { corePassed: number; coreTotal: number; ok: boolean } {
    const core = results.filter((r) => r.core);
    const corePassed = core.filter((r) => r.passed).length;
    return { corePassed, coreTotal: core.length, ok: corePassed === core.length };
}
