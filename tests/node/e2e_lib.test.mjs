import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Checks, checkAmendment, classOf, claimResultOf, expectedChallengers, healthOf, renderReport, sameTally, tallyOf } from '../../scripts/e2e-lib.mjs';

test('the class table', () => {
  assert.equal(classOf('YES', 'YES'), 'LOOPHOLE');
  assert.equal(classOf('YES', 'NO'), 'FINE');
  assert.equal(classOf('NO', 'YES'), 'WORKING');
  assert.equal(classOf('NO', 'NO'), 'OVERREACH');
  assert.equal(classOf('UNCLEAR', 'NO'), 'INCONCLUSIVE');
  assert.equal(classOf('YES', ''), 'INCONCLUSIVE');
});

test('claims', () => {
  assert.equal(claimResultOf('LOOPHOLE', 'LOOPHOLE'), 'CONFIRMED');
  assert.equal(claimResultOf('LOOPHOLE', 'FINE'), 'REFUTED');
  assert.equal(claimResultOf('OVERREACH', 'INCONCLUSIVE'), 'INCONCLUSIVE');
});

test('health and tally', () => {
  assert.equal(healthOf({}), 'UNTESTED');
  assert.equal(healthOf({ FINE: 1 }), 'NO_KNOWN_FLAWS');
  assert.equal(healthOf({ LOOPHOLE: 1 }), 'LEAKY');
  assert.equal(healthOf({ OVERREACH: 1 }), 'OVERBROAD');
  assert.equal(healthOf({ OVERREACH: 1, LOOPHOLE: 2 }), 'LEAKY_AND_OVERBROAD');
  assert.ok(sameTally({ FINE: 1, LOOPHOLE: 0 }, { LOOPHOLE: 0, WORKING: 0, OVERREACH: 0, FINE: 1 }));
  assert.deepEqual(tallyOf([{ state: 'SETTLED', klass: 'FINE' }, { state: 'PENDING', klass: '' }, { state: 'SETTLED', klass: 'INCONCLUSIVE' }]), { LOOPHOLE: 0, WORKING: 0, OVERREACH: 0, FINE: 1 });
});

test('challenger bookkeeping', () => {
  const book = expectedChallengers([
    { state: 'SETTLED', author: 'a', claim_result: 'CONFIRMED', first_class: 'LOOPHOLE' },
    { state: 'SETTLED', author: 'a', claim_result: 'REFUTED', first_class: 'FINE' },
    { state: 'SETTLED', author: 'b', claim_result: 'CONFIRMED', first_class: 'OVERREACH' },
    { state: 'SETTLED', author: 'b', claim_result: 'INCONCLUSIVE', first_class: 'INCONCLUSIVE' },
    { state: 'PENDING', author: 'c' },
  ]);
  assert.deepEqual(book.a, { loopholes: 1, overreaches: 0, refuted: 1, inconclusive: 0, score: 2 });
  assert.deepEqual(book.b, { loopholes: 0, overreaches: 1, refuted: 0, inconclusive: 1, score: 2 });
  assert.equal(book.c, undefined);
});

test('the ratchet check notices a broken scenario in an accepted amendment', () => {
  const rule = { version: 1, text: 'old', purpose: 'p', history: [{ text: 'old' }], tally: {} };
  const before = { rule, scenarios: [{ scenario_id: 'SCN-1', state: 'SETTLED', klass: 'FINE', compliant: 'YES' }] };
  const after = {
    rule: { version: 2, text: 'new', purpose: 'p', history: [{ text: 'old' }, { text: 'new' }], tally: { OVERREACH: 1, LOOPHOLE: 0, WORKING: 0, FINE: 0 } },
    scenarios: [{ scenario_id: 'SCN-1', state: 'SETTLED', klass: 'OVERREACH', compliant: 'NO' }],
  };
  const checks = new Checks();
  checkAmendment(checks, { label: 'x', before, after, amendment: { result: 'ACCEPTED', base_version: 1, regressions: [], results: [{ scenario_id: 'SCN-1', now: 'OVERREACH' }] }, proposedText: 'new' });
  assert.ok(checks.failedInvariants.some((item) => item.name.includes('the ratchet')));
});

test('a rejected amendment must not change anything', () => {
  const rule = { version: 1, text: 'old', purpose: 'p', history: [{ text: 'old' }], tally: {} };
  const before = { rule, scenarios: [{ scenario_id: 'SCN-1', state: 'SETTLED', klass: 'FINE', compliant: 'YES' }] };
  const after = { rule: { ...rule, version: 2 }, scenarios: before.scenarios };
  const checks = new Checks();
  checkAmendment(checks, { label: 'x', before, after, amendment: { result: 'REJECTED', base_version: 1, regressions: [], results: [] }, proposedText: 'new' });
  const failed = checks.failedInvariants.map((item) => item.name);
  assert.ok(failed.includes('rejected: version and text are unchanged'));
  assert.ok(failed.includes('rejected: names at least one regression'));
});

test('the report states a failed invariant plainly', () => {
  const checks = new Checks();
  checks.invariant('a', 'holds', true);
  checks.invariant('a', 'breaks', false, 'detail | with pipe');
  checks.expectation('b', 'model says X', false, 'observed Y');
  const run = {
    network: 'n', rpc: 'r', accounts: { owner: '0x1' }, contract: { address: '0x2', deployedHere: false, version: '1', sourceSha256: '0x3', runner: 'r' },
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', steps: [], scenarios: [], amendments: [], checks, finalRule: null, leaderboard: null,
  };
  const report = renderReport(run);
  assert.match(report, /Verdict: FAIL/);
  assert.match(report, /1\/2 contract invariants held/);
  assert.match(report, /\*\*FAILED\*\*/);
  assert.match(report, /detail \\\| with pipe/);
  assert.match(report, /Model deviations/);
});
