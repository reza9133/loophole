"""
Shared test support: a programmable fake model and a small harness around the GenVM direct runner.

The direct runner executes the real contract file on the real GenVM Python SDK with a mocked WASI
layer. Web and model calls are answered by handlers installed on the VM context, so the tests
control exactly what "the validators' model" says, including malformed, hostile and disagreeing
answers.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / 'contracts' / 'loophole.py'
MODULE_NAME = '_contract_loophole'

RULE_BLOCK = re.compile(r'=== BEGIN RULE \(untrusted text\) ===\n(.*?)\n=== END RULE ===', re.S)
PURPOSE_BLOCK = re.compile(r'=== BEGIN PURPOSE \(untrusted text\) ===\n(.*?)\n=== END PURPOSE ===', re.S)
SCENARIO_BLOCK = re.compile(r'=== BEGIN SCENARIOS \(untrusted text\) ===\n(.*?)\n=== END SCENARIOS ===', re.S)


def parse_prompt(prompt: str) -> Dict[str, Any]:
    rule = RULE_BLOCK.search(prompt)
    purpose = PURPOSE_BLOCK.search(prompt)
    scenarios = SCENARIO_BLOCK.search(prompt)
    items = []
    if scenarios:
        for chunk in scenarios.group(1).split('\n---\n'):
            match = re.match(r'id: (\S+)\nscenario: (.*)', chunk, re.S)
            if match:
                items.append({'id': match.group(1), 'text': match.group(2)})
    return {
        'rule': rule.group(1) if rule else '',
        'purpose': purpose.group(1) if purpose else '',
        'scenarios': items,
        'with_harm': '"harmful"' in prompt.split('=== BEGIN RULE')[0],
    }


def words(text: str, start: int, count: int) -> str:
    parts = text.split()
    return ' '.join(parts[start:start + count])


class FakeModel:
    """
    Answers the contract's review prompt.

    `compliance(rule_text, scenario_text)` and `harm(purpose, scenario_text)` return YES, NO or
    UNCLEAR. Evidence is generated verbatim from the sources, so by default every answer is
    well supported. Hooks let a test corrupt that on purpose.
    """

    def __init__(self) -> None:
        self.compliance: Callable[[str, str], str] = lambda rule, scenario: 'UNCLEAR'
        self.harm: Callable[[str, str], str] = lambda purpose, scenario: 'UNCLEAR'
        self.calls: List[Dict[str, Any]] = []
        self.raise_error = False
        self.raw_override: Optional[Callable[[], Any]] = None
        self.mutate_item: Optional[Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]] = None
        self.drop_ids: List[str] = []
        self.as_text = False
        self.wrap_in_prose = False
        self.keyed_object = False

    # -- scripting helpers --------------------------------------------------------------
    def script(self, table: Dict[str, Dict[str, str]]) -> None:
        """table maps a substring of the scenario text to {'compliant': ..., 'harmful': ...}."""

        def find(scenario: str) -> Dict[str, str]:
            for needle, answers in table.items():
                if needle in scenario:
                    return answers
            return {}

        self.compliance = lambda rule, scenario: find(scenario).get('compliant', 'UNCLEAR')
        self.harm = lambda purpose, scenario: find(scenario).get('harmful', 'UNCLEAR')

    # -- the handler installed on the VM -------------------------------------------------
    def __call__(self, data: Dict[str, Any]) -> Dict[str, Any]:
        prompt = data.get('prompt', '')
        info = parse_prompt(prompt)
        self.calls.append(info)
        if self.raise_error:
            raise RuntimeError('the model is unavailable')
        if self.raw_override is not None:
            return {'ok': self.raw_override()}
        results = []
        for scenario in info['scenarios']:
            if scenario['id'] in self.drop_ids:
                continue
            item: Dict[str, Any] = {
                'id': scenario['id'],
                'compliant': self.compliance(info['rule'], scenario['text']),
                'rule_words': words(info['rule'], 0, 5),
                'act_words': words(scenario['text'], 0, 5),
                'reason': 'scripted',
            }
            if info['with_harm']:
                item['harmful'] = self.harm(info['purpose'], scenario['text'])
                item['purpose_words'] = words(info['purpose'], 0, 4)
                item['effect_words'] = words(scenario['text'], 2, 4)
            if self.mutate_item is not None:
                item = self.mutate_item(item, scenario)
            results.append(item)
        if self.keyed_object:
            payload: Any = {'results': {entry['id']: entry for entry in results}}
        else:
            payload = {'results': results}
        if self.as_text:
            text = json.dumps(payload)
            if self.wrap_in_prose:
                text = 'Here is my answer:\n```json\n' + text + '\n```\nHope that helps.'
            return {'ok': text}
        return {'ok': payload}


class Harness:
    """A deployed contract plus the levers a test needs."""

    def __init__(self, vm: Any, contract: Any, model: FakeModel, module: Any, addresses: Dict[str, Any]) -> None:
        self.vm = vm
        self.c = contract
        self.model = model
        self.mod = module
        self.addr = addresses

    def set_time(self, stamp: str) -> None:
        """Move the transaction clock. The direct runner's warp() only affects the first message."""
        self.vm.warp(stamp)
        sys.modules['genlayer.gl'].message_raw['datetime'] = stamp

    def as_(self, who: str) -> None:
        self.vm.sender = self.addr[who]

    def hex(self, who: str) -> str:
        value = self.addr[who]
        raw = bytes(value) if isinstance(value, (bytes, bytearray)) else bytes(value.as_bytes)
        return '0x' + raw.hex()

    def j(self, raw: str) -> Any:
        return json.loads(raw)

    def bundle(self, rule_id: str) -> Dict[str, Any]:
        return json.loads(self.c.get_rule_bundle(rule_id))

    def scenario(self, scenario_id: str) -> Dict[str, Any]:
        return json.loads(self.c.get_scenario_bundle(scenario_id))['scenario']

    def stats(self) -> Dict[str, Any]:
        return json.loads(self.c.stats())


def load_module() -> Any:
    return sys.modules[MODULE_NAME]
