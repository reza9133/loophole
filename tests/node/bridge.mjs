// A test double for the live network: spawns tools/bridge.py (the real contract on the real GenVM
// Python SDK, with a scripted model) and exposes the same api seam that scripts/e2e.mjs uses.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startBridge({ mode = 'faithful', seed = 7 } = {}) {
  const python = process.env.PYTHON || path.join(ROOT, '..', 'venv', 'bin', 'python');
  const child = spawn(process.env.PYTHON || (await pythonPath()), [path.join(ROOT, 'tools', 'bridge.py'), '--mode', mode, '--seed', String(seed)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  void python;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const requests = child.stdio[3];
  const responses = createInterface({ input: child.stdio[4] });
  const waiting = new Map();
  let ready;
  const readyPromise = new Promise((resolve, reject) => {
    ready = resolve;
    child.once('exit', (code) => reject(new Error(`bridge exited with ${code}\n${stderr.slice(-2000)}`)));
  });
  responses.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.ready) ready(message);
    else waiting.get(message.id)?.(message);
  });
  const hello = await readyPromise;
  let next = 0;
  const call = (payload) =>
    new Promise((resolve, reject) => {
      next += 1;
      const id = next;
      waiting.set(id, (message) => {
        waiting.delete(id);
        if (!message.ok) reject(new Error(message.error));
        else resolve(message);
      });
      requests.write(JSON.stringify({ id, ...payload }) + '\n');
    });

  const api = {
    accounts: hello.accounts,
    async write(who, fn, args, label) {
      const reply = await call({ op: 'write', who, fn, args });
      if (reply.execution === 'failed') throw new Error(`${label} failed: ${reply.failure}`);
      return {
        hash: reply.hash,
        statusName: 'ACCEPTED',
        finality: 'accepted',
        transaction: { result: { payload: { readable: JSON.stringify(reply.value) } } },
      };
    },
    async reject(who, fn, args, label) {
      const reply = await call({ op: 'write', who, fn, args });
      if (reply.execution !== 'failed') throw new Error(`${label} was accepted, but the contract should have rejected it.`);
      return { hash: reply.hash, statusName: 'ACCEPTED', finality: 'accepted', failure: reply.failure };
    },
    async read(fn, args = []) {
      const reply = await call({ op: 'read', who: 'owner', fn, args });
      return JSON.parse(reply.value);
    },
    async readText(fn, args = []) {
      const reply = await call({ op: 'read', who: 'owner', fn, args });
      return String(reply.value);
    },
  };
  return {
    api,
    async stop() {
      requests.end();
      child.kill();
    },
  };
}

async function pythonPath() {
  const { existsSync } = await import('node:fs');
  const venv = path.join(ROOT, '..', 'venv', 'bin', 'python');
  for (const candidate of [path.join(ROOT, '.venv', 'bin', 'python'), venv, 'python3']) {
    if (candidate === 'python3' || existsSync(candidate)) return candidate;
  }
  return 'python3';
}
