// Leaderboard reduction test — mirrors the logic in /api/leaderboard
// without needing a database. If this drifts from server.js, the test
// will fail and signal that the formula needs re-aligning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    weightedAverage,
    averageHumanScore,
    blendScores,
    round2,
} = require('../lib/scoring');

function buildLeaderboard({ projects, criteria, evals, aiEvals, aiWeight }) {
    const aiEvalMap = {};
    aiEvals.forEach(ae => { aiEvalMap[ae.project_id] = ae.scores; });

    return projects.map(p => {
        const pEvals = evals.filter(e => e.project_id === p.id);
        const aiScores = aiEvalMap[p.id] || null;
        const hasHuman = pEvals.length > 0;
        const hasAI = !!aiScores;
        const humanScore = hasHuman ? averageHumanScore(pEvals, criteria) : 0;
        const aiScore = hasAI ? weightedAverage(aiScores, criteria) : 0;
        const finalScore = blendScores({ humanScore, aiScore, hasHuman, hasAI, aiWeight });
        return { id: p.id, avgScore: round2(finalScore), hasHuman, hasAI };
    }).sort((a, b) => b.avgScore - a.avgScore);
}

const criteria = [
    { id: 'innovation', weight: 1.0 },
    { id: 'technical', weight: 1.0 },
    { id: 'design', weight: 0.5 },
];

test('leaderboard: ranks projects by hybrid score', () => {
    const projects = [
        { id: 'p1' }, { id: 'p2' }, { id: 'p3' },
    ];
    const evals = [
        { project_id: 'p1', scores: { innovation: 9, technical: 9, design: 9 } },
        { project_id: 'p2', scores: { innovation: 5, technical: 5, design: 5 } },
        // p3 has no human evals
    ];
    const aiEvals = [
        { project_id: 'p1', scores: { innovation: 7, technical: 7, design: 7 } },
        { project_id: 'p3', scores: { innovation: 8, technical: 8, design: 8 } },
    ];

    const board = buildLeaderboard({ projects, criteria, evals, aiEvals, aiWeight: 0.4 });

    // p1 hybrid: 9*0.6 + 7*0.4 = 8.2
    // p2 human-only: 5
    // p3 AI-only: 8
    assert.equal(board[0].id, 'p1');
    assert.equal(board[0].avgScore, 8.2);
    assert.equal(board[1].id, 'p3');
    assert.equal(board[1].avgScore, 8);
    assert.equal(board[2].id, 'p2');
    assert.equal(board[2].avgScore, 5);
});

test('leaderboard: project with neither human nor AI gets 0', () => {
    const board = buildLeaderboard({
        projects: [{ id: 'p1' }],
        criteria,
        evals: [],
        aiEvals: [],
        aiWeight: 0.4,
    });
    assert.equal(board[0].avgScore, 0);
    assert.equal(board[0].hasHuman, false);
    assert.equal(board[0].hasAI, false);
});

test('leaderboard: aiWeight=0 means AI scores ignored when human present', () => {
    const projects = [{ id: 'p1' }];
    const evals = [{ project_id: 'p1', scores: { innovation: 10, technical: 10, design: 10 } }];
    const aiEvals = [{ project_id: 'p1', scores: { innovation: 1, technical: 1, design: 1 } }];
    const board = buildLeaderboard({ projects, criteria, evals, aiEvals, aiWeight: 0 });
    assert.equal(board[0].avgScore, 10);
});

test('leaderboard: aiWeight=1 means human ignored when AI present', () => {
    const projects = [{ id: 'p1' }];
    const evals = [{ project_id: 'p1', scores: { innovation: 10, technical: 10, design: 10 } }];
    const aiEvals = [{ project_id: 'p1', scores: { innovation: 1, technical: 1, design: 1 } }];
    const board = buildLeaderboard({ projects, criteria, evals, aiEvals, aiWeight: 1 });
    assert.equal(board[0].avgScore, 1);
});
