// npm run play:embed   — the 20-sentence playground from 04-strengths-and-limits.md §4.
//
// Prints, for both modes:
//   1. the prediction table: each pair, what you predicted, the real score
//   2. nearest statement for every question (what "top 1" search would return)
//   3. the gap between in-scope and out-of-scope best matches (your first minScore hint)
//
// It doesn't pass or fail anything (that's npm run eval:embed). It's for LOOKING.
import { embed, EMBEDDING_MODEL } from "../../src/core/llm.js";
import { embedSentences, loadCases, nearestStatement, similarity, type Mode, type VectorsById } from "../../evals/knowledge/embeddings/checks.js";

const cases = loadCases();
const text = new Map(cases.sentences.map((s) => [s.id, s.text]));
const short = (id: string) => {
    const t = text.get(id) ?? id;
    return `${id} ${t.length > 38 ? `${t.slice(0, 37)}…` : t}`;
};

const vectors: Record<Mode, VectorsById> = {
    similarity: await embedSentences(cases.sentences, "similarity", embed),
    retrieval: await embedSentences(cases.sentences, "retrieval", embed),
};

console.log(`\n=== 1. Predictions (${EMBEDDING_MODEL}) ===`);
console.log("similarity = everything SEMANTIC_SIMILARITY · retrieval = questions QUERY, statements DOCUMENT\n");
console.log(`${"pair".padEnd(86)} predict  similarity  retrieval  shows`);
for (const p of cases.pairs) {
    const sim = similarity(vectors.similarity, p.a, p.b).toFixed(3);
    const ret = similarity(vectors.retrieval, p.a, p.b).toFixed(3);
    console.log(`${`${short(p.a)}  ~  ${short(p.b)}`.padEnd(86)} ${p.predict.padEnd(8)} ${sim.padStart(10)} ${ret.padStart(10)}  ${p.shows}`);
}

console.log("\n=== 2. Nearest statement for every question (retrieval mode) ===\n");
const questions = cases.sentences.filter((s) => s.role === "question");
const best = new Map<string, number>();
for (const q of questions) {
    const top = nearestStatement(cases, vectors.retrieval, q.id);
    best.set(q.id, top.score);
    console.log(`${short(q.id).padEnd(44)} → ${short(top.id).padEnd(44)} ${top.score.toFixed(3)}`);
}

console.log("\n=== 3. Where would a threshold go? ===\n");
const sorted = [...best.entries()].sort((a, b) => b[1] - a[1]);
for (const [id, score] of sorted) console.log(`${score.toFixed(3)}  ${short(id)}`);
console.log(
    "\nIn-scope questions (returns, refunds, warranty) should sit above the traps (O020, refrigerators)." +
    "\nThe gap between them is your first guess for minScore. Part 3 calibrates it on real chunks.",
);
