// npm run test:embed   — no API call, no DB, no cost.
// (.env must exist because core/env.ts validates it on import, but nothing connects.)
//
// Tests the deterministic parts of Part 1:
//   - core/vector.ts maths (including the by-hand example from 02-measuring-similarity.md §3)
//   - splitIntoBatches / readEmbeddingResponse in core/llm.ts
//   - embed() end to end with Gemini's embedContent MOCKED: batching, order, config, errors, retries
//   - the eval's check logic (checks.ts) with fake vectors, and that cases.json is valid
// The real model: npm run eval:embed.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApiError } from "@google/genai";
import {
    ai,
    embed,
    EMBED_BATCH_SIZE,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    LlmApiError,
    readEmbeddingResponse,
    splitIntoBatches,
} from "../../src/core/llm.js";
import {
    cosineDistance,
    cosineSimilarity,
    dot,
    euclideanDistance,
    isNormalized,
    l2Norm,
    normalize,
} from "../../src/core/vector.js";
import { embedSentences, loadCases, parseCases, runCheck, summarize, type Cases, type EmbedFn } from "./embeddings/checks.js";

const close = (actual: number, expected: number, eps = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= eps, `expected ≈${expected}, got ${actual}`);

// A fake "Gemini vector": 768 numbers, deliberately NOT unit length (like a truncated real one).
const rawVector = (seed: number, dims = EMBEDDING_DIMENSIONS) =>
    Array.from({ length: dims }, (_, i) => Math.sin(seed * 31 + i) * 3);

// ── core/vector.ts ─────────────────────────────────────────────────────

test("vector: the by-hand example from 02-measuring-similarity.md", () => {
    const A = [4, 3], B = [3, 4], C = [-3, 1];
    assert.equal(dot(A, B), 24);
    assert.equal(l2Norm(A), 5);
    close(cosineSimilarity(A, B), 0.96);
    close(cosineSimilarity(A, C), -9 / (5 * Math.sqrt(10)));
    close(cosineSimilarity([1, 0], [1, 1]), Math.SQRT1_2); // revision question 1: 45°
});

test("vector: cosine ignores length, euclidean does not", () => {
    close(cosineSimilarity([1, 2, 3], [10, 20, 30]), 1);
    assert.ok(euclideanDistance([1, 2, 3], [10, 20, 30]) > 30);
});

test("vector: after normalize, cosine = dot and euclidean² = 2 − 2·cos", () => {
    const a = normalize(rawVector(1));
    const b = normalize(rawVector(2));
    assert.ok(isNormalized(a) && isNormalized(b));
    const cos = cosineSimilarity(a, b);
    close(dot(a, b), cos, 1e-12);
    close(euclideanDistance(a, b) ** 2, 2 - 2 * cos, 1e-9);
    close(cosineDistance(a, b), 1 - cos, 1e-12);
});

test("vector: caller bugs throw instead of returning a wrong number", () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length mismatch \(2 vs 3\)/);
    assert.throws(() => dot([], []), /must not be empty/);
    assert.throws(() => normalize([0, 0, 0]), /zero/);
    assert.throws(() => cosineSimilarity([0, 0], [1, 1]), /zero vector/);
});

test("vector: cosine is clamped to [-1, 1] despite floating-point error", () => {
    const v = normalize([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    const s = cosineSimilarity(v, v);
    assert.ok(s <= 1 && s >= 0.999999);
});

// ── core/llm.ts helpers ────────────────────────────────────────────────

test("splitIntoBatches: sizes, order, edge cases", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batches = splitIntoBatches(items, 100);
    assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
    assert.deepEqual(batches.flat(), items);
    assert.deepEqual(splitIntoBatches([], 100), []);
    assert.deepEqual(splitIntoBatches([1, 2], 100), [[1, 2]]);
    assert.throws(() => splitIntoBatches([1], 0), /invalid size/);
});

test("readEmbeddingResponse: normalises every vector and keeps order", () => {
    const res = { embeddings: [{ values: rawVector(1) }, { values: rawVector(2) }] };
    const vectors = readEmbeddingResponse(res, 2);
    assert.equal(vectors.length, 2);
    for (const v of vectors) {
        assert.equal(v.length, EMBEDDING_DIMENSIONS);
        assert.ok(isNormalized(v, 1e-9));
    }
    // order kept: vector 0 points the same way as input 0, not input 1
    close(cosineSimilarity(vectors[0]!, rawVector(1)), 1, 1e-9);
});

test("readEmbeddingResponse: rejects responses that break the contract", () => {
    assert.throws(() => readEmbeddingResponse({ embeddings: [{ values: rawVector(1) }] }, 2), /expected 2 embeddings, got 1/);
    assert.throws(() => readEmbeddingResponse({}, 1), /expected 1 embeddings, got 0/);
    assert.throws(() => readEmbeddingResponse({ embeddings: [{ values: rawVector(1, 3072) }] }, 1), /3072 dimensions, expected 768/);
    assert.throws(() => readEmbeddingResponse({ embeddings: [{}] }, 1), /0 dimensions/);
    const withNaN = rawVector(1);
    withNaN[10] = Number.NaN;
    assert.throws(() => readEmbeddingResponse({ embeddings: [{ values: withNaN }] }, 1), /NaN or Infinity/);
});

// ── embed() with Gemini mocked ─────────────────────────────────────────

type EmbedParams = { model: string; contents: string[]; config: { taskType: string; outputDimensionality: number } };

function mockEmbedContent(t: TestContext, impl?: (params: EmbedParams, call: number) => unknown) {
    let call = 0;
    const calls: EmbedParams[] = [];
    // Each text gets a vector seeded by its number, so the test can check the order.
    const fake = async (params: EmbedParams) => {
        calls.push(params);
        call++;
        if (impl) return impl(params, call);
        return { embeddings: params.contents.map((text) => ({ values: rawVector(Number(text.split(" ")[1])) })) };
    };
    t.mock.method(ai.models, "embedContent", fake as never);
    t.mock.method(console, "log", () => { });
    t.mock.method(console, "warn", () => { });
    return calls;
}

test("embed: [] returns [] without calling the API", async (t) => {
    const calls = mockEmbedContent(t);
    assert.deepEqual(await embed([], { taskType: "RETRIEVAL_QUERY" }), []);
    assert.equal(calls.length, 0);
});

test("embed: an empty or blank text is a caller bug, refused before any API call", async (t) => {
    const calls = mockEmbedContent(t);
    await assert.rejects(embed(["ok", "   "], { taskType: "RETRIEVAL_DOCUMENT" }), /text 1 is empty/);
    assert.equal(calls.length, 0);
});

test("embed: sends the model, task type and 768 dimensions", async (t) => {
    const calls = mockEmbedContent(t);
    const [v] = await embed(["text 1"], { taskType: "RETRIEVAL_QUERY" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, EMBEDDING_MODEL);
    assert.equal(calls[0]!.config.taskType, "RETRIEVAL_QUERY");
    assert.equal(calls[0]!.config.outputDimensionality, EMBEDDING_DIMENSIONS);
    assert.ok(isNormalized(v!, 1e-9));
});

test("embed: 250 texts → 3 batched calls, one vector per text, same order", async (t) => {
    const calls = mockEmbedContent(t);
    const texts = Array.from({ length: 250 }, (_, i) => `text ${i}`);
    const vectors = await embed(texts, { taskType: "RETRIEVAL_DOCUMENT" });
    assert.deepEqual(calls.map((c) => c.contents.length), [EMBED_BATCH_SIZE, EMBED_BATCH_SIZE, 50]);
    assert.equal(vectors.length, 250);
    for (const i of [0, 99, 100, 249]) close(cosineSimilarity(vectors[i]!, rawVector(i)), 1, 1e-9);
});

test("embed: a response with the wrong count fails loudly (never misaligned vectors)", async (t) => {
    mockEmbedContent(t, (params) => ({ embeddings: params.contents.slice(1).map(() => ({ values: rawVector(1) })) }));
    await assert.rejects(embed(["text 1", "text 2"], { taskType: "RETRIEVAL_DOCUMENT" }), /expected 2 embeddings, got 1/);
});

test("embed: a 400 is not retried and becomes LlmApiError", async (t) => {
    const calls = mockEmbedContent(t, () => { throw new ApiError({ message: "API key not valid", status: 400 }); });
    await assert.rejects(embed(["text 1"], { taskType: "RETRIEVAL_QUERY" }), (err: unknown) => {
        assert.ok(err instanceof LlmApiError);
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        return true;
    });
    assert.equal(calls.length, 1);
});

test("embed: a 429 is retried, then succeeds", async (t) => {
    const calls = mockEmbedContent(t, (params, call) => {
        if (call === 1) throw new ApiError({ message: "rate limited", status: 429 });
        return { embeddings: params.contents.map(() => ({ values: rawVector(7) })) };
    });
    const vectors = await embed(["text 7"], { taskType: "RETRIEVAL_QUERY" });   // waits ~1 s (first backoff)
    assert.equal(calls.length, 2);
    assert.equal(vectors.length, 1);
});

// ── the eval's check logic ─────────────────────────────────────────────

test("cases.json is valid and every referenced id exists", () => {
    const cases = loadCases();
    assert.equal(cases.sentences.length, 20);
    assert.ok(cases.checks.some((c) => c.core) && cases.checks.some((c) => !c.core));
});

test("parseCases: a typo in an id fails loudly", () => {
    const bad = {
        sentences: [{ id: "S01", group: "g", role: "question", text: "a" }, { id: "S02", group: "g", role: "statement", text: "b" }],
        pairs: [{ a: "S01", b: "S99", predict: "high", shows: "x" }],
        checks: [],
    };
    assert.throws(() => parseCases(bad), /unknown sentence ids: S99/);
});

// Tiny world in 2-D: angles make the expected order obvious.
const tiny: Cases = {
    sentences: [
        { id: "S01", group: "g", role: "question", text: "return question" },
        { id: "S02", group: "g", role: "statement", text: "return rule" },
        { id: "S03", group: "g", role: "statement", text: "refund rule" },
        { id: "S04", group: "g", role: "question", text: "out of scope" },
    ],
    pairs: [],
    checks: [],
};
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const tinyVectors = new Map([["S01", at(0)], ["S02", at(10)], ["S03", at(40)], ["S04", at(80)]]);

test("runCheck: higher / top_document / best_match_lower", () => {
    const base = { mode: "similarity" as const, core: true, why: "" };
    assert.equal(runCheck(tiny, { ...base, id: "a", kind: "higher", higher: ["S01", "S02"], lower: ["S01", "S03"] }, tinyVectors).passed, true);
    assert.equal(runCheck(tiny, { ...base, id: "b", kind: "higher", higher: ["S01", "S03"], lower: ["S01", "S02"] }, tinyVectors).passed, false);
    assert.equal(runCheck(tiny, { ...base, id: "c", kind: "top_document", query: "S01", expected: "S02" }, tinyVectors).passed, true);
    assert.equal(runCheck(tiny, { ...base, id: "d", kind: "top_document", query: "S01", expected: "S03" }, tinyVectors).passed, false);
    // S04's best match (S03 at 40°, 40° away) is weaker than S01's best (S02, 10° away)
    assert.equal(runCheck(tiny, { ...base, id: "e", kind: "best_match_lower", outOfScope: "S04", inScope: ["S01"] }, tinyVectors).passed, true);
});

test("summarize: only core checks decide the result", () => {
    const r = (core: boolean, passed: boolean) => ({ id: "x", core, passed, detail: "", why: "" });
    assert.deepEqual(summarize([r(true, true), r(false, false)]), { corePassed: 1, coreTotal: 1, ok: true });
    assert.equal(summarize([r(true, true), r(true, false)]).ok, false);
});

test("embedSentences: retrieval mode embeds questions as QUERY and statements as DOCUMENT", async () => {
    const seen: { taskType: string; texts: string[] }[] = [];
    const fakeEmbed: EmbedFn = async (texts, { taskType }) => {
        seen.push({ taskType, texts });
        return texts.map((_, i) => at(i * 10));
    };
    const byId = await embedSentences(tiny.sentences, "retrieval", fakeEmbed);
    assert.deepEqual(seen.map((s) => s.taskType), ["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT"]);
    assert.deepEqual(seen[0]!.texts, ["return question", "out of scope"]);
    assert.equal(byId.size, 4);

    seen.length = 0;
    await embedSentences(tiny.sentences, "similarity", fakeEmbed);
    assert.deepEqual(seen.map((s) => s.taskType), ["SEMANTIC_SIMILARITY"]);
});
