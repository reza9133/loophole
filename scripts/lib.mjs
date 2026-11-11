// Shared helpers for the deploy and end-to-end scripts. Targets GenLayer Studionet with
// genlayer-js 1.x. Studionet is gasless, so no fee parameters are needed.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

import { executionOf, isDecision, phaseOf, settledAs, statusNameOf } from './receipt.mjs';

export { parseArgs } from './args.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RPC_URL = (process.env.LOOPHOLE_RPC || 'https://studio.genlayer.com/api').trim();
export const CHAIN_ID = 61999;

const CURVE_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sha256Of(text) {
  return '0x' + createHash('sha256').update(text).digest('hex');
}

export function readText(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** A fresh throwaway private key. Studionet accounts need no funds. */
export function freshKey() {
  for (;;) {
    const hex = randomBytes(32).toString('hex');
    const value = BigInt('0x' + hex);
    if (value > 0n && value < CURVE_ORDER) return '0x' + hex;
  }
}

/** The key from LOOPHOLE_PRIVATE_KEY, or a fresh throwaway key. */
export function loadKey() {
  const supplied = (process.env.LOOPHOLE_PRIVATE_KEY || '').trim();
  if (supplied) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(supplied)) throw new Error('LOOPHOLE_PRIVATE_KEY must be 0x followed by 64 hex characters.');
    return { key: supplied, generated: false };
  }
  return { key: freshKey(), generated: true };
}

function chainConfig() {
  return { ...studionet, rpcUrls: { ...(studionet.rpcUrls ?? {}), default: { http: [RPC_URL] } } };
}

export function makeClient(key) {
  const account = key ? createAccount(key) : undefined;
  return { client: createClient({ chain: chainConfig(), endpoint: RPC_URL, account }), account };
}

/**
 * Poll until the validators have decided the transaction (ACCEPTED, FINALIZED or a failure state).
 * Returns { transaction, statusName, execution, finality, failure }.
 *
 *   ok           = finality !== null && failure === null
 *   finality     = 'accepted' (can still be appealed) | 'finalized' (cannot change) | null
 *   execution    = 'success' | 'failed' | 'unknown', read from the transaction itself
 *
 * A decided transaction counts as completed only with an explicit successful execution result.
 * With waitForFinality the call keeps polling an ACCEPTED transaction until it is FINALIZED or
 * the finality timeout passes (the result then stays 'accepted').
 */
export async function waitForDecision(
  client,
  hash,
  { timeoutMs = 10 * 60 * 1000, intervalMs = 3000, onStatus, waitForFinality = false, finalityTimeoutMs = 45 * 60 * 1000 } = {},
) {
  const started = Date.now();
  let last = null;
  let lastStatus = 'PENDING';
  let reported = '';
  let rereads = 0;
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${hash}.`);
    try {
      last = await client.getTransaction({ hash });
      lastStatus = statusNameOf(last);
      if (onStatus && lastStatus !== reported) {
        reported = lastStatus;
        onStatus(lastStatus);
      }
      const phase = phaseOf(lastStatus);
      if (isDecision(phase)) {
        // The status can move before the execution result is attached. Read again instead of guessing.
        if (phase !== 'failed' && executionOf(last).state === 'unknown' && rereads < 10) rereads += 1;
        else break;
      }
    } catch (error) {
      if (Date.now() - started > 45_000) throw error;
    }
    await sleep(intervalMs);
  }

  const result = describeDecision(last, lastStatus);
  if (waitForFinality && result.finality === 'accepted') {
    const finalityStarted = Date.now();
    while (Date.now() - finalityStarted < finalityTimeoutMs) {
      await sleep(Math.max(intervalMs, 10_000));
      try {
        const again = await client.getTransaction({ hash });
        const status = statusNameOf(again);
        if (onStatus && status !== reported) {
          reported = status;
          onStatus(status);
        }
        if (phaseOf(status) === 'finalized' || phaseOf(status) === 'failed') return describeDecision(again, status);
      } catch {
        // a missed poll changes nothing
      }
    }
  }
  return result;
}

/** Pure: what a decided (or failed) transaction object means. Exported for tests. */
export function describeDecision(transaction, statusName) {
  const phase = phaseOf(statusName);
  if (phase === 'failed' || !isDecision(phase)) {
    return {
      transaction,
      statusName,
      execution: 'unknown',
      finality: null,
      failure: `The validators did not reach agreement (${statusName.toLowerCase().replace(/_/g, ' ')}). Nothing was written.`,
    };
  }
  const execution = executionOf(transaction);
  const finality = settledAs(statusName, execution);
  let failure = null;
  if (execution.state === 'failed') failure = execution.message;
  else if (execution.state === 'unknown') failure = 'The network decided this transaction, but its execution result could not be read, so it is not treated as completed.';
  return { transaction, statusName, execution: execution.state, finality, failure };
}

/**
 * Read a view method and return its raw result. Studionet rate-limits reads per address, so a
 * failed read is retried with a growing pause before giving up.
 */
export async function readRaw(client, address, functionName, args = []) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await client.readContract({
        address,
        functionName,
        args: args.map((value) => (typeof value === 'number' ? BigInt(value) : value)),
      });
    } catch (error) {
      lastError = error;
      await sleep(900 * attempt);
    }
  }
  throw new Error(`Could not read ${functionName}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

/** Read a view method that returns JSON text. */
export async function readJson(client, address, functionName, args = []) {
  const raw = await readRaw(client, address, functionName, args);
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error(`${functionName} did not return JSON: ${String(raw).slice(0, 120)}`);
  }
}

export async function send(client, address, functionName, args, label, options = {}) {
  console.log(`  -> ${label}`);
  const hash = String(
    await client.writeContract({
      address,
      functionName,
      args: args.map((value) => (typeof value === 'number' ? BigInt(value) : value)),
      value: 0n,
    }),
  );
  console.log(`     submitted ${hash}`);
  const outcome = await waitForDecision(client, hash, { onStatus: (name) => console.log(`     status: ${name}`), ...options });
  if (outcome.failure) throw new Error(`${label} failed: ${outcome.failure}`);
  console.log(`     decision ${outcome.statusName}, execution ${outcome.execution}, ${outcome.finality === 'finalized' ? 'FINALIZED' : 'accepted, not final yet'}`);
  return { hash, ...outcome };
}

/**
 * Send a write that is expected to be rejected by the contract itself (a UserError). The network
 * still decides such a transaction, with a failed execution result. Resolves with the failure
 * text; throws if the transaction unexpectedly succeeded or never reached a decision.
 */
export async function sendExpectingRejection(client, address, functionName, args, label, options = {}) {
  console.log(`  -> ${label} (expected to be rejected)`);
  const hash = String(
    await client.writeContract({
      address,
      functionName,
      args: args.map((value) => (typeof value === 'number' ? BigInt(value) : value)),
      value: 0n,
    }),
  );
  console.log(`     submitted ${hash}`);
  const outcome = await waitForDecision(client, hash, { onStatus: (name) => console.log(`     status: ${name}`), ...options });
  if (outcome.execution === 'success') throw new Error(`${label} was accepted, but the contract should have rejected it.`);
  if (outcome.execution !== 'failed') throw new Error(`${label} did not reach a readable decision: ${outcome.failure}`);
  console.log(`     rejected: ${outcome.failure}`);
  return { hash, ...outcome };
}
