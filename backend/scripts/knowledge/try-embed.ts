// npm run try:embed -- "Can I return my phone?" "What's the return process for mobiles?"
//
// The smallest possible look at an embedding: what comes back, how long it is,
// whether it's normalised, and how similar two texts are. One API call.
import { embed, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../src/core/llm.js";
import { cosineSimilarity, euclideanDistance, l2Norm, dot } from "../../src/core/vector.js";

const texts = process.argv.slice(2);
if (texts.length === 0) texts.push("Can I return my phone?", "What's the return process for mobiles?");

const vectors = await embed(texts, { taskType: "SEMANTIC_SIMILARITY" });

console.log(`\nmodel: ${EMBEDDING_MODEL}   expected dims: ${EMBEDDING_DIMENSIONS}\n`);
texts.forEach((text, i) => {
    const v = vectors[i]!;
    const preview = v.slice(0, 6).map((x) => x.toFixed(4)).join(", ");
    console.log(`"${text}"`);
    console.log(`  dims=${v.length}  length=${l2Norm(v).toFixed(4)}  [${preview}, ...]\n`);
});

if (vectors.length >= 2) {
    const [a, b] = vectors as [number[], number[]];
    console.log("first two texts:");
    console.log(`  cosine similarity  ${cosineSimilarity(a, b).toFixed(4)}`);
    console.log(`  dot product        ${dot(a, b).toFixed(4)}   (same as cosine, because both vectors have length 1)`);
    console.log(`  euclidean distance ${euclideanDistance(a, b).toFixed(4)}   (= √(2 − 2·cos) for unit vectors)`);
}
