import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parsePreserveQuery } from './config.js';
import { applyPreservedQuery, normalisePageUrls, withPreservedQuery } from './pages.js';

const seed = 'http://new-wooagency:8888/?qa-showcase=1&utm_source=mail';
const base = new URL(seed);

describe('parsePreserveQuery', () => {
  it('splits comma or space lists and de-dupes', () => {
    assert.deepEqual(parsePreserveQuery('qa-showcase, preview'), ['qa-showcase', 'preview']);
    assert.deepEqual(parsePreserveQuery('qa-showcase qa-showcase'), ['qa-showcase']);
    assert.deepEqual(parsePreserveQuery(''), []);
    assert.deepEqual(parsePreserveQuery(undefined), []);
  });
});

describe('normalisePageUrls', () => {
  const hrefs = [
    'http://new-wooagency:8888/?utm_source=nav',
    'http://new-wooagency:8888/about/',
    'http://new-wooagency:8888/projects/?ref=hero',
    'http://new-wooagency:8888/services/',
    'http://new-wooagency:8888/contact/?utm_campaign=x',
    'http://new-wooagency:8888/journal/',
    'https://linkedin.com/company/windowofopportunity',
  ];

  it('strips every query when no keys are preserved (default)', () => {
    const urls = normalisePageUrls(hrefs, base, 10, []);
    assert.ok(urls.every((u) => !new URL(u).search), urls.join('\n'));
    assert.ok(urls.some((u) => new URL(u).pathname.replace(/\/+$/, '') === '/about'));
    assert.ok(!urls.some((u) => u.includes('linkedin.com')));
  });

  it('copies whitelisted keys from the seed onto discovered paths', () => {
    const urls = normalisePageUrls(hrefs, base, 10, ['qa-showcase']);
    const byPath = Object.fromEntries(urls.map((u) => [new URL(u).pathname.replace(/\/+$/, '') || '/', u]));
    assert.equal(new URL(byPath['/']).search, '?qa-showcase=1');
    assert.equal(new URL(byPath['/about']).search, '?qa-showcase=1');
    assert.equal(new URL(byPath['/projects']).search, '?qa-showcase=1');
    assert.equal(new URL(byPath['/services']).search, '?qa-showcase=1');
    assert.equal(new URL(byPath['/contact']).search, '?qa-showcase=1');
    assert.equal(new URL(byPath['/journal']).search, '?qa-showcase=1');
  });

  it('does not keep tracking params even when they were on the seed or the link', () => {
    const urls = normalisePageUrls(hrefs, base, 10, ['qa-showcase']);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      assert.equal(q.get('utm_source'), null, u);
      assert.equal(q.get('utm_campaign'), null, u);
      assert.equal(q.get('ref'), null, u);
    }
  });
});

describe('withPreservedQuery / applyPreservedQuery', () => {
  it('rewrites a stale pages.json row to the seed flag', () => {
    const out = withPreservedQuery('http://new-wooagency:8888/projects/', seed, ['qa-showcase']);
    assert.equal(out, 'http://new-wooagency:8888/projects/?qa-showcase=1');
  });

  it('is a no-op on the list when the whitelist is empty', () => {
    const rows = ['http://new-wooagency:8888/about/'];
    assert.deepEqual(applyPreservedQuery(rows, seed, []), rows);
  });
});

describe('loadConfig preserveQuery', () => {
  it('CLI --preserve-query wins over env', () => {
    const prev = process.env.QA_PRESERVE_QUERY;
    process.env.QA_PRESERVE_QUERY = 'from-env';
    try {
      const cfg = loadConfig(['https://example.com/', '--preserve-query', 'qa-showcase']);
      assert.deepEqual(cfg.preserveQuery, ['qa-showcase']);
    } finally {
      if (prev === undefined) delete process.env.QA_PRESERVE_QUERY;
      else process.env.QA_PRESERVE_QUERY = prev;
    }
  });

  it('empty env / empty flag keeps the old strip-all behaviour', () => {
    const prev = process.env.QA_PRESERVE_QUERY;
    process.env.QA_PRESERVE_QUERY = '';
    try {
      const cfg = loadConfig(['https://example.com/']);
      assert.deepEqual(cfg.preserveQuery, []);
    } finally {
      if (prev === undefined) delete process.env.QA_PRESERVE_QUERY;
      else process.env.QA_PRESERVE_QUERY = prev;
    }
  });
});
