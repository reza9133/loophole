#!/usr/bin/env node
// Deploy contracts/loophole.py to GenLayer Studionet and verify it.
//
//   npm run deploy:contract
//
// Optional environment:
//   LOOPHOLE_PRIVATE_KEY   0x... key to deploy from (default: a throwaway key; Studionet needs no funds)
//   LOOPHOLE_RPC           RPC endpoint (default: https://studio.genlayer.com/api)
//
// Writes deployments/studionet.json (note: not artifacts/, which the Python test plugin clears).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CHAIN_ID, ROOT, RPC_URL, loadKey, makeClient, readJson, readText, sha256Of, waitForDecision } from './lib.mjs';

export function addressFromReceipt(transaction) {
  const candidates = [
    transaction?.data?.contract_address,
    transaction?.data?.contractAddress,
    transaction?.txDataDecoded?.contractAddress,
    transaction?.txDataDecoded?.contract_address,
    transaction?.recipient,
    transaction?.to_address,
  ];
  return candidates.find((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value)) ?? null;
}

/** Deploy the contract and return what a later script needs. Shared with the e2e script. */
export async function deployLoophole({ client, account, log = console.log }) {
  const source = readText('contracts/loophole.py');
  const header = source.split('\n', 1)[0];
  if (!header.startsWith('# { "Depends": "py-genlayer:')) throw new Error('The contract must start with its runner pin comment.');

  log(`  deployer  ${account.address}`);
  log(`  runner    ${header.match(/py-genlayer:[a-z0-9]+/)?.[0]}`);
  log(`  source    ${sha256Of(source)}`);

  const hash = String(await client.deployContract({ code: source, args: [] }));
  log(`  submitted ${hash}`);
  const outcome = await waitForDecision(client, hash, { onStatus: (name) => log(`  status: ${name}`) });
  if (outcome.failure) throw new Error(`Deployment failed: ${outcome.failure}`);

  const address = addressFromReceipt(outcome.transaction);
  if (!address) {
    throw new Error(`The deployment was accepted but the contract address was not in the receipt. Open ${hash} in the Studionet explorer and copy the contract address.`);
  }
  log(`  contract  ${address}`);

  const info = await readJson(client, address, 'contract_info');
  const stats = await readJson(client, address, 'stats');
  if (info.name !== 'Loophole') throw new Error(`Unexpected contract name: ${info.name}`);
  if (stats.rules !== 0 || stats.scenarios !== 0) throw new Error('A freshly deployed contract should hold no rules and no scenarios.');
  log(`  verified  ${info.name} ${info.version}, ${stats.rules} rules`);

  return {
    network: 'studionet',
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    address,
    deployTransaction: hash,
    deployer: account.address,
    sourceSha256: sha256Of(source),
    runner: info.runner,
    version: info.version,
    deployedAt: new Date().toISOString(),
    info,
  };
}

async function main() {
  const { key, generated } = loadKey();
  const { client, account } = makeClient(key);
  console.log('Loophole deployment');
  console.log(`  network   Studionet (chain ${CHAIN_ID})`);
  console.log(`  rpc       ${RPC_URL}${generated ? '\n  key       throwaway (Studionet needs no funds)' : ''}`);
  const record = await deployLoophole({ client, account });
  const { info, ...saved } = record;
  mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  writeFileSync(path.join(ROOT, 'deployments', 'studionet.json'), JSON.stringify(saved, null, 2) + '\n');
  console.log('\nWrote deployments/studionet.json');
  console.log(`\nNext: npm run e2e -- --address ${record.address}`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
