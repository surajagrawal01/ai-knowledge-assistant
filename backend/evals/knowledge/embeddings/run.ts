// npm run eval:embed   — real Gemini calls (3 small requests, ~20 short texts), costs a fraction of a cent.
//
// Checks that the embedding model orders meanings the way Part 1 predicts:
//   core checks (E*, R*) must all pass  → embed(), task types and normalisation are wired correctly
//   limit/explore checks (L*, R05)       → reported only; they demonstrate known weaknesses
//
// Orderings, not thresholds: "paraphrase scores higher than unrelated" holds across models,
// while "paraphrase scores above 0.8" doesn't. Thresholds are calibrated later, in Part 3.
import { embed, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../../src/core/llm.js";
import { embedSentences, loadCases, runChecks, summarize } from "./checks.js";

const cases = loadCases();

const vectorsByMode = {
    similarity: await embedSentences(cases.sentences, "similarity", embed),
    retrieval: await embedSentences(cases.sentences, "retrieval", embed),
};
console.log("🚀 ~ vectorsByMode:", vectorsByMode)

const results = runChecks(cases, vectorsByMode);

console.log(`\nEmbedding eval · ${EMBEDDING_MODEL} · ${EMBEDDING_DIMENSIONS} dims · ${cases.sentences.length} sentences\n`);
for (const r of results) {
    const mark = r.passed ? "PASS" : r.core ? "FAIL" : "note";
    console.log(`${mark.padEnd(4)}  ${r.id.padEnd(4)} ${r.core ? "core " : "info "} ${r.detail}`);
    console.log(`            ${r.why}`);
}

const { corePassed, coreTotal, ok } = summarize(results);
console.log(`\nCore: ${corePassed}/${coreTotal} ${ok ? "✅" : "❌"}  (pass bar: all core checks)`);
process.exit(ok ? 0 : 1);
