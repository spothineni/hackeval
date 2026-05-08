// Pure functions for score computation. Kept dependency-free so they're easy to test.

function weightedAverage(scoresById, criteria) {
    const totalWeight = criteria.reduce((s, c) => s + c.weight, 0) || 1;
    let weighted = 0;
    for (const c of criteria) {
        weighted += (Number(scoresById?.[c.id]) || 0) * c.weight;
    }
    return weighted / totalWeight;
}

function averageHumanScore(evaluations, criteria) {
    if (!evaluations.length) return 0;
    const perEval = evaluations.map(ev => {
        const scores = typeof ev.scores === 'string' ? JSON.parse(ev.scores) : ev.scores;
        return weightedAverage(scores, criteria);
    });
    return perEval.reduce((s, v) => s + v, 0) / perEval.length;
}

function blendScores({ humanScore, aiScore, hasHuman, hasAI, aiWeight }) {
    const w = Math.max(0, Math.min(1, Number(aiWeight)));
    if (hasHuman && hasAI) return humanScore * (1 - w) + aiScore * w;
    if (hasHuman) return humanScore;
    if (hasAI) return aiScore;
    return 0;
}

function clampScore(value) {
    const n = Math.round(Number(value));
    if (Number.isNaN(n)) return 5;
    return Math.max(1, Math.min(10, n));
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = { weightedAverage, averageHumanScore, blendScores, clampScore, round2 };
