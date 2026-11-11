// Dress rehearsal of the live e2e run. The same orchestration that runs on Studionet runs here
// against the real contract with a scripted model. A faithful model must pass everything. A
// hesitant, hostile, chaotic or broken model must never make a contract invariant fail: the
// contract's guarantees hold whatever the validators' model says.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderReport } from '../../scripts/e2e-lib.mjs';
import { runE2E } from '../../scripts/e2e.mjs';
import { startBridge } from './bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'e2e-data.json'), 'utf8'));
const contract = { address: '0x' + 'ab'.repeat(20), deployedHere: true, deployTransaction: '0x00', version: '1.0.0', runner: 'py-genlayer:test', sourceSha256: '0x00' };

async function rehearse(mode, seed = 7) {
  const bridge = await startBridge({ mode, seed });
  try {
    const lines = [];
    const run = await runE2E({ api: bridge.api, data, contract, network: 'rehearsal', rpc: 'bridge', log: (line) => lines.push(line) });
    return { run, lines };
  } finally {
    await bridge.stop();
  }
}

function summary(run) {
  return run.checks.failedInvariants.map((item) => `${item.area}: ${item.name} (${item.detail})`);
}

test('a faithful model passes every invariant and meets every expectation', async () => {
  const { run } = await rehearse('faithful');
  assert.deepEqual(summary(run), []);
  assert.deepEqual(run.checks.deviations.map((item) => `${item.area}: ${item.name}`), []);
  const counts = run.checks.counts();
  assert.ok(counts.invariants > 70, `expected a thorough run, got ${counts.invariants} invariants`);
  assert.equal(run.amendments[0].record.result, 'ACCEPTED');
  assert.equal(run.amendments[1].record.result, 'REJECTED');
  assert.equal(run.finalRule.status, 'RETIRED');
  assert.equal(run.finalRule.version, 2);
  assert.deepEqual(run.scenarios.map((entry) => entry.record.first_class), ['LOOPHOLE', 'OVERREACH', 'WORKING', 'FINE']);
  const report = renderReport(run);
  assert.match(report, /Verdict: PASS/);
  assert.match(report, /## Scenarios/);
});

test('a hesitant model: inconclusive scenarios are retried and the run still passes', async () => {
  const { run, lines } = await rehearse('hazy');
  assert.deepEqual(summary(run), []);
  assert.ok(lines.some((line) => line.includes('inconclusive: submitting the same story again')), 'the retry path should have been exercised');
  assert.ok(run.scenarios.every((entry) => entry.attempt >= 2 || entry.record.first_class !== 'INCONCLUSIVE'));
});

test('a contrarian model gives wrong answers but never breaks an invariant', async () => {
  const { run } = await rehearse('contrarian');
  assert.deepEqual(summary(run), []);
  assert.ok(run.checks.deviations.length > 0, 'the deviations should be reported');
  assert.match(renderReport(run), /Model deviations/);
});

for (const seed of [1, 2, 3, 4, 5]) {
  test(`a chaotic model (seed ${seed}) with broken evidence never breaks an invariant`, async () => {
    const { run } = await rehearse('chaos', seed);
    assert.deepEqual(summary(run), []);
  });
}

test('a model that is down leaves every scenario inconclusive and still passes', async () => {
  const { run } = await rehearse('down');
  assert.deepEqual(summary(run), []);
  assert.ok(run.scenarios.every((entry) => entry.record.first_class === 'INCONCLUSIVE'));
  assert.ok(run.amendments.every((entry) => entry.record.result === 'ACCEPTED' && entry.record.note === 'NO_REGRESSION_SUITE' || entry.record.result === 'ACCEPTED'));
});

test('a failing transport still yields a report that says where the run stopped', async () => {
  const bridge = await startBridge({ mode: 'faithful' });
  try {
    let writes = 0;
    const api = {
      ...bridge.api,
      async write(...args) {
        writes += 1;
        if (writes === 4) throw new Error('RPC unavailable');
        return bridge.api.write(...args);
      },
    };
    const run = await runE2E({ api, data, contract, network: 'rehearsal', rpc: 'bridge', log: () => {} });
    assert.ok(run.finishedAt !== '');
    assert.deepEqual(run.checks.failedInvariants.map((item) => item.name), ['the lifecycle ran to the end']);
    assert.match(run.checks.failedInvariants[0].detail, /RPC unavailable/);
    assert.match(renderReport(run), /Verdict: FAIL/);
  } finally {
    await bridge.stop();
  }
});

test('a contract that accepts a write it must reject is reported, not hidden', async () => {
  const bridge = await startBridge({ mode: 'faithful' });
  try {
    const api = {
      ...bridge.api,
      async reject(who, fn, args, label) {
        if (fn === 'amend_rule') throw new Error(`${label} was accepted, but the contract should have rejected it.`);
        return bridge.api.reject(who, fn, args, label);
      },
    };
    const run = await runE2E({ api, data, contract, network: 'rehearsal', rpc: 'bridge', log: () => {} });
    const failed = run.checks.failedInvariants.map((item) => item.name);
    assert.ok(failed.some((name) => name.includes('A stranger tries to amend the rule: rejected by the contract')));
  } finally {
    await bridge.stop();
  }
});

test('an unreadable rejection reason is a deviation, not a contract fault', async () => {
  const bridge = await startBridge({ mode: 'faithful' });
  try {
    const api = {
      ...bridge.api,
      async reject(who, fn, args, label) {
        const result = await bridge.api.reject(who, fn, args, label);
        return { ...result, failure: 'The contract rejected this transaction. Open it in the explorer for the execution log.' };
      },
    };
    const run = await runE2E({ api, data, contract, network: 'rehearsal', rpc: 'bridge', log: () => {} });
    assert.deepEqual(run.checks.failedInvariants, []);
    assert.ok(run.checks.deviations.some((item) => item.name.includes('reason is readable')));
  } finally {
    await bridge.stop();
  }
});

test('a wrong rejection reason is a failed invariant', async () => {
  const bridge = await startBridge({ mode: 'faithful' });
  try {
    const api = {
      ...bridge.api,
      async reject(who, fn, args, label) {
        const result = await bridge.api.reject(who, fn, args, label);
        return { ...result, failure: "UserError('something else entirely')" };
      },
    };
    const run = await runE2E({ api, data, contract, network: 'rehearsal', rpc: 'bridge', log: () => {} });
    assert.ok(run.checks.failedInvariants.some((item) => item.name.includes('reason mentions')));
  } finally {
    await bridge.stop();
  }
});
