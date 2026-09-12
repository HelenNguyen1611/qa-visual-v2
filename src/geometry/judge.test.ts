import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksTruncated, parseBatch, parseBatchAudit } from './judge.js';

describe('parseBatch', () => {
  it('maps verdicts by id and marks a missing id uncertain', () => {
    const raw = JSON.stringify({
      verdicts: [
        { id: 'a', verdict: 'valid', reason: 'lệch rõ' },
        { id: 'b', verdict: 'rejected', reason: 'carousel' },
      ],
    });
    const out = parseBatch(raw, ['a', 'b', 'c']);
    assert.equal(out[0].verdict, 'valid');
    assert.equal(out[1].verdict, 'rejected');
    assert.equal(out[2].verdict, 'uncertain');
    assert.equal(out[0].parseStatus, 'ok');
    assert.equal(out[1].parseStatus, 'ok');
    assert.equal(out[2].parseStatus, 'id-missing');
  });

  it('accepts a single object when only one candidate was sent', () => {
    const out = parseBatch('{"id":"a","verdict":"rejected","reason":"x"}', ['a']);
    assert.equal(out[0].verdict, 'rejected');
    assert.equal(out[0].parseStatus, 'ok');
  });
});

describe('parseBatchAudit', () => {
  it('labels model-said uncertain separately from missing id', () => {
    const raw = JSON.stringify({
      verdicts: [{ id: 'a', verdict: 'uncertain', reason: 'không chắc gap 0' }],
    });
    const audit = parseBatchAudit(raw, ['a', 'b']);
    assert.equal(audit.results[0].parseStatus, 'uncertain-model');
    assert.equal(audit.results[0].reason, 'không chắc gap 0');
    assert.equal(audit.results[1].parseStatus, 'id-missing');
  });

  it('does not remap by index when the model returns a different id', () => {
    const raw = JSON.stringify({
      verdicts: [{ id: 'zzz', verdict: 'valid', reason: 'lệch' }],
    });
    const audit = parseBatchAudit(raw, ['a']);
    assert.equal(audit.results[0].verdict, 'uncertain');
    assert.equal(audit.results[0].parseStatus, 'id-mismatch');
    assert.deepEqual(audit.extraIds, ['zzz']);
  });

  it('keeps a correct id as ok even if the model also invented extras', () => {
    const raw = JSON.stringify({
      verdicts: [
        { id: 'a', verdict: 'rejected', reason: 'carousel' },
        { id: 'ghost', verdict: 'valid', reason: 'x' },
      ],
    });
    const audit = parseBatchAudit(raw, ['a']);
    assert.equal(audit.results[0].parseStatus, 'ok');
    assert.equal(audit.results[0].verdict, 'rejected');
    assert.deepEqual(audit.extraIds, ['ghost']);
  });

  it('trims ids before matching', () => {
    const raw = JSON.stringify({
      verdicts: [{ id: '  a  ', verdict: 'valid', reason: 'lệch' }],
    });
    const audit = parseBatchAudit(raw, ['a']);
    assert.equal(audit.results[0].parseStatus, 'ok');
    assert.equal(audit.results[0].verdict, 'valid');
  });

  it('marks unparseable complete text as parse-failure', () => {
    const audit = parseBatchAudit('the model wrote prose without json', ['a']);
    assert.equal(audit.parseFailure, true);
    assert.equal(audit.results[0].parseStatus, 'parse-failure');
    assert.equal(audit.results[0].verdict, 'uncertain');
  });

  it('marks cut-off json as truncated, not remapped', () => {
    const raw = '{"verdicts":[{"id":"a","verdict":"valid","reason":"ok"}]}\n{"id":"b","verdict":"rej';
    assert.equal(looksTruncated(raw), true);
    const audit = parseBatchAudit(raw, ['a', 'b']);
    assert.equal(audit.truncated, true);
    assert.equal(audit.results[0].parseStatus, 'truncated');
    assert.equal(audit.results[0].verdict, 'valid');
    assert.equal(audit.results[1].parseStatus, 'truncated');
    assert.equal(audit.results[1].verdict, 'uncertain');
  });

  it('marks an empty reply as truncated', () => {
    const audit = parseBatchAudit('', ['a']);
    assert.equal(audit.results[0].parseStatus, 'truncated');
    assert.equal(audit.results[0].verdict, 'uncertain');
  });

  it('keeps the model verdict when the wrapper is cut but the row is complete', () => {
    const raw =
      '{\n  "verdicts": [\n    {\n      "id": "container-alignment:n3",\n      "verdict": "rejected",\n      "reason": "Khối tràn viền."\n';
    const audit = parseBatchAudit(raw, ['container-alignment:n3']);
    assert.equal(audit.truncated, true);
    assert.equal(audit.results[0].verdict, 'rejected');
    assert.equal(audit.results[0].reason, 'Khối tràn viền.');
    assert.equal(audit.results[0].parseStatus, 'truncated');
  });
});
