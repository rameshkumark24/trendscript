import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiOutputError } from '../lib/errors.js';
import {
  DEFAULT_CHAPTERS,
  normalizeChapters,
  normalizeHashtags,
  normalizePackage,
  normalizeTopics,
} from '../lib/normalize.js';
import { VALID_PACKAGE } from './helpers.js';

describe('normalizeTopics', () => {
  it('returns cleaned, de-duplicated topics capped at six', () => {
    const topics = normalizeTopics({
      topics: ['  "Topic one"  ', 'Topic One', 'Topic two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'ab'],
    });
    assert.deepEqual(topics, ['Topic one', 'Topic two', 'Three', 'Four', 'Five', 'Six']);
  });

  it('accepts a differently named array and object items', () => {
    assert.deepEqual(normalizeTopics({ ideas: [{ title: 'From title' }, { topic: 'From topic' }, 42] }), [
      'From title',
      'From topic',
    ]);
  });

  it('throws a retryable error when no topics are usable', () => {
    assert.throws(() => normalizeTopics({ message: 'sorry' }), AiOutputError);
    assert.throws(() => normalizeTopics({ topics: ['', 'x'] }), AiOutputError);
    assert.throws(() => normalizeTopics(null), AiOutputError);
  });
});

describe('normalizeHashtags', () => {
  it('accepts a string, adds missing # and always includes #shorts', () => {
    assert.deepEqual(normalizeHashtags('fitness, #gym  #Fitness'), ['#fitness', '#gym', '#shorts']);
  });

  it('strips punctuation, drops non-strings and caps the count', () => {
    const tags = normalizeHashtags(['#back pain!', 7, '##ok', ...Array.from({ length: 12 }, (_, i) => `t${i}`)]);
    assert.equal(tags[0], '#backpain');
    assert.equal(tags[1], '#ok');
    assert.equal(tags.length, 8);
    assert.equal(tags.at(-1), '#shorts');
  });

  it('keeps an existing #shorts without duplicating it', () => {
    assert.deepEqual(normalizeHashtags(['#Shorts', '#a']), ['#Shorts', '#a']);
  });

  it('handles missing input', () => {
    assert.deepEqual(normalizeHashtags(undefined), ['#shorts']);
  });
});

describe('normalizeChapters', () => {
  it('falls back to default chapters when missing or too short', () => {
    assert.deepEqual(normalizeChapters(undefined), DEFAULT_CHAPTERS);
    assert.deepEqual(normalizeChapters([{ time: '0:00', label: 'Only one' }]), DEFAULT_CHAPTERS);
  });

  it('parses strings, sorts by time, normalizes 00:xx and forces a 0:00 start', () => {
    const chapters = normalizeChapters(['00:15 - Reveal', { timestamp: '0:02', title: 'Hook' }, 'bad', { time: '9:99', label: 'x' }]);
    assert.deepEqual(chapters, [
      { time: '0:00', label: 'Hook' },
      { time: '0:15', label: 'Reveal' },
    ]);
  });
});

describe('normalizePackage', () => {
  it('passes through a valid package', () => {
    const pkg = normalizePackage(VALID_PACKAGE, { topic: 'x' });
    assert.equal(pkg.title, VALID_PACKAGE.title);
    assert.deepEqual(pkg.script, VALID_PACKAGE.script);
    assert.deepEqual(pkg.chapters, VALID_PACKAGE.chapters);
  });

  it('accepts alternative script keys, a nested package and a flat script', () => {
    const nested = normalizePackage(
      { package: { script: { hook: 'h', build_up: 'b', payoff: 'c', call_to_action: 'd' } } },
      { topic: 'Fallback title' },
    );
    assert.deepEqual(nested.script, { hook: 'h', buildup: 'b', climax: 'c', cta: 'd' });
    assert.equal(nested.title, 'Fallback title');
    assert.deepEqual(nested.hashtags, ['#shorts']);

    const flat = normalizePackage({ title: 'T', hook: 'h', buildup: 'b', climax: 'c', cta: 'd' }, { topic: 'x' });
    assert.equal(flat.script.cta, 'd');
  });

  it('coerces non-string fields safely', () => {
    const pkg = normalizePackage({ ...VALID_PACKAGE, title: 12, caption: { text: 'x' } }, { topic: 'Topic' });
    assert.equal(pkg.title, 'Topic');
    assert.equal(pkg.caption, '');
  });

  it('rejects a package with a missing script phase', () => {
    const broken = { ...VALID_PACKAGE, script: { ...VALID_PACKAGE.script, cta: '  ' } };
    assert.throws(() => normalizePackage(broken, { topic: 'x' }), /missing: cta/);
    assert.throws(() => normalizePackage('nope', { topic: 'x' }), AiOutputError);
  });
});
