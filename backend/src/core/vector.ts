// Plain vector maths. No AI, no I/O, no provider names: just arrays of numbers.

export type Vector = number[];

function assertSameLength(a: Vector, b: Vector, fn: string): void {
    if (a.length === 0 || b.length === 0) throw new Error(`${fn}: vectors must not be empty`);
    if (a.length !== b.length) {
        // The classic bug: comparing a 768-d vector with a 3072-d one from another model/config.
        throw new Error(`${fn}: length mismatch (${a.length} vs ${b.length})`);
    }
}

export function isFiniteVector(v: Vector): boolean {
    return v.length > 0 && v.every((x) => Number.isFinite(x));
}

// Σ aᵢ·bᵢ
export function dot(a: Vector, b: Vector): number {
    assertSameLength(a, b, "dot");
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
    return sum;
}

// √(Σ vᵢ²): the vector's length
export function l2Norm(v: Vector): number {
    if (v.length === 0) throw new Error("l2Norm: vector must not be empty");
    let sum = 0;
    for (const x of v) sum += x * x;
    return Math.sqrt(sum);
}

// Same direction, length 1. After this, cosine similarity = dot product.
export function normalize(v: Vector): Vector {
    const norm = l2Norm(v);
    if (norm === 0 || !Number.isFinite(norm)) {
        // A zero vector has no direction, so "meaning" is undefined. Never store one.
        throw new Error("normalize: cannot normalise a zero or non-finite vector");
    }
    return v.map((x) => x / norm);
}

export function isNormalized(v: Vector, tolerance = 1e-3): boolean {
    return Math.abs(l2Norm(v) - 1) <= tolerance;
}

// cos θ = (a·b) / (|a|·|b|), in [-1, 1]. 1 = same direction (same meaning).
// Works for any vectors; for normalised ones it equals dot(a, b).
export function cosineSimilarity(a: Vector, b: Vector): number {
    assertSameLength(a, b, "cosineSimilarity");
    const denominator = l2Norm(a) * l2Norm(b);
    if (denominator === 0) throw new Error("cosineSimilarity: zero vector");
    // Clamp: floating-point error can give 1.0000000002, which breaks "score <= 1" checks.
    return Math.min(1, Math.max(-1, dot(a, b) / denominator));
}

// What pgvector's <=> operator returns (Part 2): 1 − cosine similarity, in [0, 2].
export function cosineDistance(a: Vector, b: Vector): number {
    return 1 - cosineSimilarity(a, b);
}

// √(Σ (aᵢ − bᵢ)²): pgvector's <-> operator. For normalised vectors it ranks
// exactly like cosine (distance² = 2 − 2·cos), so the choice only matters for
// unnormalised vectors.
export function euclideanDistance(a: Vector, b: Vector): number {
    assertSameLength(a, b, "euclideanDistance");
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i]! - b[i]!;
        sum += d * d;
    }
    return Math.sqrt(sum);
}
