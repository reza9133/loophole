import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeDecision } from '../../scripts/lib.mjs';
import { executionOf, findIdInReceipt, isDecision, phaseOf, settledAs, statusNameOf } from '../../scripts/receipt.mjs';

const success = { statusName: 'ACCEPTED', consensus_data: { leader_receipt: [{ execution_result: 'SUCCESS', result: { payload: { readable: "'RUL-0001'" } } }] } };
const userError = {
  statusName: 'ACCEPTED',
  consensus_data: { leader_receipt: [{ execution_result: 'ERROR', genvm_result: { stderr: "UserError('only the owner may amend this rule')" } }] },
};

test('status names come from names, numeric codes or strings', () => {
  assert.equal(statusNameOf({ statusName: 'accepted' }), 'ACCEPTED');
  assert.equal(statusNameOf({ status: '7' }), 'FINALIZED');
  assert.equal(statusNameOf({ status: 5 }), 'ACCEPTED');
  assert.equal(statusNameOf({ status: 'leader timeout' }), 'LEADER_TIMEOUT');
  assert.equal(statusNameOf(null), 'UNKNOWN');
});

test('phases', () => {
  assert.equal(phaseOf('FINALIZED'), 'finalized');
  assert.equal(phaseOf('ACCEPTED'), 'accepted');
  assert.equal(phaseOf('UNDETERMINED'), 'failed');
  assert.equal(phaseOf('PENDING'), 'queued');
  assert.equal(phaseOf('COMMITTING'), 'consensus');
  assert.ok(isDecision('accepted') && isDecision('failed') && !isDecision('consensus'));
});

test('a successful execution is success, a UserError is a failure with its message', () => {
  assert.equal(executionOf(success).state, 'success');
  const failed = executionOf(userError);
  assert.equal(failed.state, 'failed');
  assert.match(failed.message, /only the owner may amend this rule/);
  assert.equal(executionOf({ statusName: 'ACCEPTED' }).state, 'unknown');
});

test('an accepted transaction with a failed execution is never treated as completed', () => {
  const decided = describeDecision(userError, 'ACCEPTED');
  assert.equal(decided.execution, 'failed');
  assert.equal(decided.finality, null);
  assert.match(decided.failure, /only the owner/);
  const fine = describeDecision(success, 'ACCEPTED');
  assert.equal(fine.finality, 'accepted');
  assert.equal(fine.failure, null);
  assert.equal(describeDecision(success, 'FINALIZED').finality, 'finalized');
});

test('no agreement and unreadable results are failures, not successes', () => {
  assert.match(describeDecision({}, 'UNDETERMINED').failure, /did not reach agreement/);
  assert.match(describeDecision({ statusName: 'ACCEPTED' }, 'ACCEPTED').failure, /could not be read/);
  assert.equal(settledAs('ACCEPTED', { state: 'unknown' }), null);
});

test('ids are found in a receipt', () => {
  assert.equal(findIdInReceipt(success, 'RUL'), 'RUL-0001');
  assert.equal(findIdInReceipt(success, 'SCN'), null);
});
