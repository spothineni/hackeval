const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile } = require('../lib/validate');

test('validateProfile: empty / undefined fields are accepted', () => {
    assert.equal(validateProfile({}), null);
    assert.equal(validateProfile({ bio: null, skills: null }), null);
});

test('validateProfile: bio length cap', () => {
    assert.equal(validateProfile({ bio: 'a'.repeat(5000) }), null);
    assert.match(validateProfile({ bio: 'a'.repeat(5001) }), /bio/);
    assert.match(validateProfile({ bio: 12345 }), /bio/);
});

test('validateProfile: skills array shape', () => {
    assert.equal(validateProfile({ skills: ['React', 'Postgres'] }), null);
    assert.match(validateProfile({ skills: 'react' }), /array/);
    assert.match(validateProfile({ skills: new Array(51).fill('x') }), /50/);
    assert.match(validateProfile({ skills: [''] }), /1-60/);
    assert.match(validateProfile({ skills: ['x'.repeat(61)] }), /1-60/);
});

test('validateProfile: URL fields must be http(s)', () => {
    assert.equal(validateProfile({ githubUrl: 'https://github.com/me' }), null);
    assert.equal(validateProfile({ githubUrl: '' }), null);
    assert.equal(validateProfile({ githubUrl: null }), null);
    assert.match(validateProfile({ githubUrl: 'javascript:alert(1)' }), /githubUrl/);
    assert.match(validateProfile({ linkedinUrl: 'not a url' }), /linkedinUrl/);
    assert.match(validateProfile({ portfolioUrl: 'ftp://example.com' }), /portfolioUrl/);
});

test('validateProfile: experienceLevel allowlist', () => {
    for (const lv of ['beginner', 'intermediate', 'advanced', 'expert']) {
        assert.equal(validateProfile({ experienceLevel: lv }), null);
    }
    assert.equal(validateProfile({ experienceLevel: '' }), null);
    assert.equal(validateProfile({ experienceLevel: null }), null);
    assert.match(validateProfile({ experienceLevel: 'guru' }), /experienceLevel/);
});

test('validateProfile: full valid payload', () => {
    const out = validateProfile({
        bio: 'short bio',
        skills: ['JS', 'Go'],
        githubUrl: 'https://github.com/me',
        linkedinUrl: 'https://linkedin.com/in/me',
        portfolioUrl: 'https://me.dev',
        experienceLevel: 'advanced',
    });
    assert.equal(out, null);
});
