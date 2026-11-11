// Pure transaction-receipt helpers for the command-line scripts: what status a transaction is in,
// whether the contract call itself succeeded, and why it failed. No network and no SDK import, so
// they are unit tested offline in tests/node/receipt.test.mjs.

const STATUS_BY_CODE = {
  0: 'UNINITIALIZED',
  1: 'PENDING',
  2: 'PROPOSING',
  3: 'COMMITTING',
  4: 'REVEALING',
  5: 'ACCEPTED',
  6: 'UNDETERMINED',
  7: 'FINALIZED',
  8: 'CANCELED',
  9: 'APPEAL_REVEALING',
  10: 'APPEAL_COMMITTING',
};

export const ACCEPTED = 'ACCEPTED';
export const FINALIZED = 'FINALIZED';
export const DECIDED = new Set([ACCEPTED, FINALIZED]);
export const FAILED = new Set(['UNDETERMINED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT']);

export function jsonText(value) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ?? '';
  } catch {
    return '';
  }
}

export function statusNameOf(transaction) {
  const tx = transaction ?? null;
  if (!tx) return 'UNKNOWN';
  const named = tx.statusName ?? tx.status_name;
  if (typeof named === 'string' && named.length > 0) return named.toUpperCase().replace(/[\s-]+/g, '_');
  const raw = tx.status;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return STATUS_BY_CODE[Number(raw)] ?? `STATUS_${raw}`;
  if (typeof raw === 'string' && raw.length > 0) return raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (typeof raw === 'number' || typeof raw === 'bigint') return STATUS_BY_CODE[Number(raw)] ?? `STATUS_${String(raw)}`;
  return 'UNKNOWN';
}

// ACCEPTED means the validators agreed but the result can still be appealed. FINALIZED means it
// cannot change. They are different phases, and neither says the contract call itself worked.
export function phaseOf(statusName) {
  if (statusName === FINALIZED) return 'finalized';
  if (statusName === ACCEPTED) return 'accepted';
  if (FAILED.has(statusName)) return 'failed';
  if (statusName === 'PENDING' || statusName === 'UNINITIALIZED' || statusName === 'UNKNOWN') return 'queued';
  return 'consensus';
}

export function isDecision(phase) {
  return phase === 'accepted' || phase === 'finalized' || phase === 'failed';
}

function leaderReceipts(transaction) {
  const consensus = transaction?.consensus_data ?? transaction?.consensusData;
  const receipts = consensus?.leader_receipt ?? consensus?.leaderReceipt;
  return Array.isArray(receipts) ? receipts.filter((entry) => entry && typeof entry === 'object') : [];
}

function cleanErrorText(text) {
  const user = text.match(/UserError[^\n:]*:\s*(.+)/);
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const picked = (user ? user[1] : lines[lines.length - 1] ?? text).trim().replace(/^['"]+|['"]+$/g, '');
  return picked.length > 300 ? `${picked.slice(0, 297)}...` : picked;
}

function failureText(leader) {
  const payload = leader?.result?.payload;
  const candidates = [leader?.genvm_result?.stderr, payload?.readable, typeof payload === 'string' ? payload : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return cleanErrorText(candidate);
  }
  return 'The contract rejected this transaction. Open it in the explorer for the execution log.';
}

const EXECUTION_SUCCESS = new Set(['SUCCESS', 'FINISHED_WITH_RETURN']);

// Success needs an explicit successful execution result. A missing or unreadable one is
// 'unknown', never success: a transaction can be ACCEPTED while the contract call raised an error.
export function executionOf(transaction) {
  const receipts = leaderReceipts(transaction);
  const results = [];
  for (const receipt of receipts) {
    const result = String(receipt.execution_result ?? receipt.executionResult ?? '').toUpperCase();
    if (result !== '') results.push({ result, receipt });
  }
  const named = String(transaction?.txExecutionResultName ?? transaction?.tx_execution_result_name ?? '').toUpperCase();
  if (named !== '' && named !== 'NOT_VOTED') results.push({ result: named });

  if (results.length === 0) return { state: 'unknown' };
  const bad = results.find((entry) => !EXECUTION_SUCCESS.has(entry.result));
  if (bad === undefined) return { state: 'success' };
  return { state: 'failed', message: failureText(bad.receipt ?? receipts[0]) };
}

/** Null unless the contract call itself failed. */
export function executionFailure(transaction) {
  const execution = executionOf(transaction);
  return execution.state === 'failed' ? execution.message : null;
}

export function settledAs(statusName, execution) {
  if (execution.state !== 'success') return null;
  if (statusName === FINALIZED) return 'finalized';
  if (statusName === ACCEPTED) return 'accepted';
  return null;
}

export function findIdInReceipt(receipt, prefix) {
  const match = jsonText(receipt).match(new RegExp(`${prefix}-\\d{4,}`));
  return match ? match[0] : null;
}
