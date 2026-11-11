import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bootstrap import share_genvm_artifacts  # noqa: E402

share_genvm_artifacts()

from support import CONTRACT, FakeModel, Harness, ROOT, load_module  # noqa: E402

DATA = json.loads((ROOT / 'scripts' / 'e2e-data.json').read_text())


@pytest.fixture
def data():
    return DATA


@pytest.fixture
def h(direct_vm, direct_deploy):
    """A freshly deployed Loophole with a scriptable model. The default sender is 'owner'."""
    from gltest.direct.loader import create_address

    model = FakeModel()
    direct_vm._live_llm_handler = model
    direct_vm.warp('2026-11-10T10:00:00Z')
    addresses = {name: create_address(name) for name in ('owner', 'alice', 'bob', 'carol')}
    direct_vm.sender = addresses['owner']
    contract = direct_deploy(str(CONTRACT))
    harness = Harness(direct_vm, contract, model, load_module(), addresses)
    harness.as_('owner')
    return harness


def bike_model(model, data):
    """Script the fake model so every e2e scenario gets its expected answers under both wordings."""
    table = {}
    for scenario in data['scenarios']:
        table[scenario['text'][:40]] = {
            'compliant': scenario['expect']['compliant'],
            'harmful': scenario['expect']['harmful'],
        }
    model.script(table)
