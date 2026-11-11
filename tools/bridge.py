"""
Offline rehearsal bridge for the live end-to-end script.

It runs the real contract file on the real GenVM Python SDK (the same direct runner the unit tests
use) and speaks a tiny JSON-lines protocol on stdin/stdout, so scripts/e2e.mjs can be rehearsed
end to end without a network. The model behind the validators is scripted and can be made faithful,
hesitant, hostile or broken to prove that the contract's invariants hold whatever the model says.

    python tools/bridge.py --mode faithful|hazy|contrarian|chaos|down

Requests arrive on file descriptor 3 and replies leave on file descriptor 4. (The GenVM SDK reads
standard input when it is imported, so standard input cannot carry the protocol.)

Requests : {"id": 1, "op": "write"|"read", "who": "owner", "fn": "...", "args": [...]}
Replies  : {"id": 1, "ok": true, "value": ..., "hash": "0x..", "execution": "success"|"failed", "failure": "..."}
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tests'))

from gltest.direct.loader import create_address, deploy_contract  # noqa: E402
from gltest.direct.vm import VMContext  # noqa: E402

from bootstrap import share_genvm_artifacts  # noqa: E402
from support import CONTRACT, FakeModel  # noqa: E402

share_genvm_artifacts()

DATA = json.loads((ROOT / 'scripts' / 'e2e-data.json').read_text())
EXPECT = {s['text'][:40]: s['expect'] for s in DATA['scenarios']}


def key_of(scenario_text: str):
    return EXPECT.get(scenario_text[:40])


def faithful_compliance(rule: str, scenario: str) -> str:
    expect = key_of(scenario)
    if expect is None:
        return 'UNCLEAR'
    if 'at most one hour' in rule:
        return 'NO'
    if 'continues the same checkout' in rule and expect['class'] == 'LOOPHOLE':
        return 'NO'
    return expect['compliant']


def faithful_harm(purpose: str, scenario: str) -> str:
    expect = key_of(scenario)
    return expect['harmful'] if expect else 'UNCLEAR'


def flip(answer: str) -> str:
    return {'YES': 'NO', 'NO': 'YES'}.get(answer, answer)


def build_model(mode: str, seed: int) -> FakeModel:
    model = FakeModel()
    model.compliance = faithful_compliance
    model.harm = faithful_harm
    rng = random.Random(seed)
    if mode == 'hazy':
        seen = set()

        def hazy(rule: str, scenario: str) -> str:
            if scenario not in seen and 'one hour' not in rule and 'continues' not in rule:
                seen.add(scenario)
                return 'UNCLEAR'
            return faithful_compliance(rule, scenario)

        model.compliance = hazy
    elif mode == 'contrarian':
        model.compliance = lambda rule, scenario: flip(faithful_compliance(rule, scenario))
        model.harm = lambda purpose, scenario: flip(faithful_harm(purpose, scenario))
    elif mode == 'chaos':
        model.compliance = lambda rule, scenario: rng.choice(['YES', 'NO', 'UNCLEAR', 'YES', 'NO'])
        model.harm = lambda purpose, scenario: rng.choice(['YES', 'NO', 'UNCLEAR', 'YES', 'NO'])

        def sabotage(item, scenario):
            roll = rng.random()
            if roll < 0.15:
                item['rule_words'] = 'words that the rule does not contain'
            elif roll < 0.25:
                item['effect_words'] = ''
            return item

        model.mutate_item = sabotage
    elif mode == 'down':
        model.raise_error = True
    elif mode != 'faithful':
        raise SystemExit('unknown mode ' + mode)
    return model


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', default='faithful')
    parser.add_argument('--seed', type=int, default=7)
    options = parser.parse_args()

    requests = os.fdopen(3, 'r')
    responses = os.fdopen(4, 'w')

    def send(payload: dict) -> None:
        responses.write(json.dumps(payload) + '\n')
        responses.flush()

    vm = VMContext()
    names = ('owner', 'alice', 'bob')
    addresses = {name: create_address(name) for name in names}
    clock = [1794304800]

    def stamp() -> str:
        import datetime

        return datetime.datetime.fromtimestamp(clock[0], datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    with vm.activate():
        model = build_model(options.mode, options.seed)
        vm._live_llm_handler = model
        vm.warp(stamp())
        vm.sender = addresses['owner']
        contract = deploy_contract(CONTRACT, vm)
        gl = sys.modules['genlayer.gl']
        hex_of = {name: '0x' + bytes(value).hex() if isinstance(value, (bytes, bytearray)) else '0x' + bytes(value.as_bytes).hex() for name, value in addresses.items()}
        send({'ready': True, 'accounts': hex_of})

        counter = 0
        for line in requests:
            line = line.strip()
            if not line:
                continue
            request = json.loads(line)
            reply = {'id': request['id']}
            try:
                who = request.get('who', 'owner')
                vm.sender = addresses[who]
                if request['op'] == 'write':
                    clock[0] += 17
                    gl.message_raw['datetime'] = stamp()
                    counter += 1
                    reply['hash'] = '0x' + format(counter, '064x')
                    try:
                        value = getattr(contract, request['fn'])(*request['args'])
                        reply.update(ok=True, execution='success', value=value)
                    except Exception as error:  # a UserError raised by the contract
                        reply.update(ok=True, execution='failed', failure=str(error))
                else:
                    value = getattr(contract, request['fn'])(*request['args'])
                    reply.update(ok=True, value=value)
            except Exception:
                reply.update(ok=False, error=traceback.format_exc())
            send(reply)


if __name__ == '__main__':
    main()
