const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    weightedAverage,
    averageHumanScore,
    blendScores,
    clampScore,
    round2,
} = require('../lib/scoring');

const criteria = [
    { id: 'innovation', weight: 1.0 },
    { id: 'technical', weight: 1.0 },
    { id: 'design', weight: 0.5 },
];

test('weightedAverage: simple equal weights', () => {
    const result = weightedAverage({ innovation: 8, technical: 6, design: 10 }, [
        { id: 'innovation', weight: 1 },
        { id: 'technical', weight: 1 },
        { id: 'design', weight: 1 },
    ]);
    assert.equal(round2(result), 8);
});

test('weightedAverage: respects criterion weights', () => {
    // (8*1 + 6*1 + 10*0.5) / 2.5 = 19/2.5 = 7.6
    const result = weightedAverage({ innovation: 8, technical: 6, design: 10 }, criteria);
    assert.equal(round2(result), 7.6);
});

test('weightedAverage: missing scores treated as 0', () => {
    // (8*1 + 0*1 + 0*0.5) / 2.5 = 3.2
    const result = weightedAverage({ innovation: 8 }, criteria);
    assert.equal(round2(result), 3.2);
});

test('weightedAverage: empty criteria does not divide by zero', () => {
    const result = weightedAverage({}, []);
    assert.equal(result, 0);
});

test('averageHumanScore: averages across multiple judges', () => {
    const evals = [
        { scores: { innovation: 8, technical: 6, design: 10 } },
        { scores: { innovation: 6, technical: 8, design: 8 } },
    ];
    // judge1 = 7.6, judge2 = (6+8+4)/2.5 = 7.2 → avg 7.4
    const result = averageHumanScore(evals, criteria);
    assert.equal(round2(result), 7.4);
});

test('averageHumanScore: parses JSON-string scores', () => {
    const evals = [{ scores: JSON.stringify({ innovation: 10, technical: 10, design: 10 }) }];
    assert.equal(round2(averageHumanScore(evals, criteria)), 10);
});

test('averageHumanScore: empty evaluations -> 0', () => {
    assert.equal(averageHumanScore([], criteria), 0);
});

test('blendScores: human only', () => {
    assert.equal(blendScores({ humanScore: 7, aiScore: 0, hasHuman: true, hasAI: false, aiWeight: 0.4 }), 7);
});

test('blendScores: AI only', () => {
    assert.equal(blendScores({ humanScore: 0, aiScore: 9, hasHuman: false, hasAI: true, aiWeight: 0.4 }), 9);
});

test('blendScores: hybrid 60/40', () => {
    // 8 * 0.6 + 6 * 0.4 = 7.2
    const result = blendScores({ humanScore: 8, aiScore: 6, hasHuman: true, hasAI: true, aiWeight: 0.4 });
    assert.equal(round2(result), 7.2);
});

test('blendScores: clamps aiWeight outside [0,1]', () => {
    assert.equal(blendScores({ humanScore: 8, aiScore: 6, hasHuman: true, hasAI: true, aiWeight: 2 }), 6);
    assert.equal(blendScores({ humanScore: 8, aiScore: 6, hasHuman: true, hasAI: true, aiWeight: -1 }), 8);
});

test('blendScores: no scores -> 0', () => {
    assert.equal(blendScores({ humanScore: 0, aiScore: 0, hasHuman: false, hasAI: false, aiWeight: 0.4 }), 0);
});

test('clampScore: rounds and clamps to [1,10]', () => {
    assert.equal(clampScore(5.6), 6);
    assert.equal(clampScore(0), 1);
    assert.equal(clampScore(-3), 1);
    assert.equal(clampScore(99), 10);
    assert.equal(clampScore('7'), 7);
});

test('clampScore: NaN-ish inputs default to 5', () => {
    assert.equal(clampScore(undefined), 5);
    assert.equal(clampScore('not-a-number'), 5);
});

test('round2: rounds to 2 decimals', () => {
    assert.equal(round2(7.236), 7.24);
    assert.equal(round2(7.234), 7.23);
});
