"""Validator equivalence: what must agree for consensus, and what must not slip through."""

import json

from test_02_judgement import setup


def leader_result(h):
    return h.vm._captured_validators[-1][0]


def judged(h, data, key='loophole'):
    rule_id, ids = setup(h, data)
    h.vm.clear_validators()
    h.c.judge_scenario(ids[key])
    return rule_id, ids


def test_validator_agrees_with_an_identical_judgement(h, data):
    judged(h, data)
    assert h.vm.run_validator() is True


def test_validator_ignores_wording_differences_that_do_not_change_answers(h, data):
    judged(h, data)

    def reword(item, scenario):
        item['reason'] = 'a completely different explanation'
        item['rule_words'] = 'at most 24 consecutive hours'
        item['act_words'] = 'keeps it parked outside their home'
        item['purpose_words'] = 'other members can find'
        item['effect_words'] = 'whole month'
        return item

    h.model.mutate_item = reword
    assert h.vm.run_validator() is True


def test_validator_rejects_a_different_compliance_answer(h, data):
    judged(h, data)
    h.model.compliance = lambda rule, scenario: 'NO'
    assert h.vm.run_validator() is False


def test_validator_rejects_a_different_harm_answer(h, data):
    judged(h, data)
    h.model.harm = lambda purpose, scenario: 'NO'
    assert h.vm.run_validator() is False


def test_validator_rejects_when_it_cannot_support_its_own_answer(h, data):
    judged(h, data)

    def weak(item, scenario):
        item['rule_words'] = 'nothing of the kind'
        return item

    h.model.mutate_item = weak
    assert h.vm.run_validator() is False


def test_validator_rejects_when_its_model_fails_but_the_leader_succeeded(h, data):
    judged(h, data)
    h.model.raise_error = True
    assert h.vm.run_validator() is False
    h.model.raise_error = False
    h.model.raw_override = lambda: 'not json'
    assert h.vm.run_validator() is False


def test_two_failed_judgements_agree(h, data):
    rule_id, ids = setup(h, data)
    h.model.raise_error = True
    h.vm.clear_validators()
    assert h.c.judge_scenario(ids['loophole']) == 'INCONCLUSIVE'
    assert json.loads(leader_result(h))['ok'] is False
    assert h.vm.run_validator() is True
    # a failed leader against a validator that got a real answer must not agree
    h.model.raise_error = False
    assert h.vm.run_validator() is False


def test_a_failed_validator_does_not_agree_with_a_failed_leader_that_it_could_have_answered(h, data):
    rule_id, ids = setup(h, data)
    h.model.raw_override = lambda: 'garbage'
    h.vm.clear_validators()
    h.c.judge_scenario(ids['loophole'])
    h.model.raw_override = None
    assert h.vm.run_validator() is False


def test_validator_rejects_a_leader_error(h, data):
    judged(h, data)
    assert h.vm.run_validator(leader_error=Exception('boom')) is False


def test_validator_rejects_garbage_leader_results(h, data):
    judged(h, data)
    for bad in ['not json', '[]', '{}', 'null', '{"ok": true}', '{"ok": true, "items": "x"}', '{"ok": true, "items": []}', '{"ok": true, "items": [1]}']:
        assert h.vm.run_validator(leader_result=bad) is False


def test_validator_rejects_a_leader_with_forged_evidence(h, data):
    judged(h, data)
    honest = json.loads(leader_result(h))
    forged = json.loads(json.dumps(honest))
    forged['items'][0]['evidence']['rule_words'] = 'a sentence the rule does not contain'
    assert h.vm.run_validator(leader_result=json.dumps(forged)) is False
    forged = json.loads(json.dumps(honest))
    forged['items'][0]['evidence']['effect_words'] = ''
    assert h.vm.run_validator(leader_result=json.dumps(forged)) is False


def test_validator_rejects_a_leader_that_lies_about_the_answer(h, data):
    judged(h, data)
    honest = json.loads(leader_result(h))
    forged = json.loads(json.dumps(honest))
    forged['items'][0]['compliant'] = 'NO'  # evidence still supports it, but the answer differs from the validator's
    assert h.vm.run_validator(leader_result=json.dumps(forged)) is False


def test_validator_rejects_a_leader_with_the_wrong_shape(h, data):
    judged(h, data)
    honest = json.loads(leader_result(h))
    for mutate in (
        lambda o: o['items'].append(dict(o['items'][0])),
        lambda o: o['items'][0].update({'id': 'S9'}),
        lambda o: o['items'][0].update({'evidence': 'text'}),
        lambda o: o['items'][0].pop('evidence'),
        lambda o: o.update({'items': None}),
    ):
        forged = json.loads(json.dumps(honest))
        mutate(forged)
        assert h.vm.run_validator(leader_result=json.dumps(forged)) is False


def test_the_write_path_never_trusts_unverified_leader_evidence(h, data):
    """Even if consensus were somehow reached on a forged outcome, the contract re-verifies it."""
    rule_id, ids = setup(h, data)
    mod = h.mod
    batch = [{'id': 'S1', 'text': data['scenarios'][0]['text']}]
    forged = {
        'ok': True,
        'items': [
            {
                'id': 'S1',
                'compliant': 'YES',
                'harmful': 'YES',
                'evidence': {'rule_words': 'invented words that are not there', 'act_words': 'a b c d e f', 'purpose_words': 'x y z w', 'effect_words': 'q r s t'},
                'reason': '',
                'flags': [],
            }
        ],
    }
    checked = mod._recheck(forged, data['rule']['text'], data['rule']['purpose'], batch, True)
    assert checked['items'][0]['compliant'] == 'UNCLEAR' and checked['items'][0]['harmful'] == 'UNCLEAR'
    assert mod._class_of(checked['items'][0]['compliant'], checked['items'][0]['harmful']) == 'INCONCLUSIVE'


def test_judge_writes_nothing_when_the_leader_function_itself_raises(h, data):
    """Leader-side errors inside a nondeterministic block must not corrupt state."""
    rule_id, ids = setup(h, data)
    snapshot = h.vm.snapshot()
    before = h.scenario(ids['loophole'])
    # a UserError inside the contract (retired rule) leaves the scenario pending
    h.c.retire_rule(rule_id)
    try:
        h.c.judge_scenario(ids['loophole'])
    except Exception:
        pass
    assert h.scenario(ids['loophole']) == before
    h.vm.revert(snapshot)


def test_leader_doubt_is_accepted_whatever_the_validator_thinks(h, data):
    """UNCLEAR fails closed, so it needs no corroboration and cannot stall consensus."""
    rule_id, ids = setup(h, data)
    h.model.compliance = lambda rule, scenario: 'UNCLEAR'
    h.vm.clear_validators()
    assert h.c.judge_scenario(ids['loophole']) == 'INCONCLUSIVE'
    h.model.compliance = lambda rule, scenario: 'YES'
    h.model.harm = lambda purpose, scenario: 'YES'
    assert h.vm.run_validator() is True


def test_leader_doubt_on_harm_only_is_accepted(h, data):
    rule_id, ids = setup(h, data)
    h.model.harm = lambda purpose, scenario: 'UNCLEAR'
    h.vm.clear_validators()
    assert h.c.judge_scenario(ids['loophole']) == 'INCONCLUSIVE'
    h.model.harm = lambda purpose, scenario: 'NO'
    assert h.vm.run_validator() is True


def test_a_definite_leader_answer_is_not_saved_by_validator_doubt(h, data):
    judged(h, data)
    h.model.compliance = lambda rule, scenario: 'UNCLEAR'
    assert h.vm.run_validator() is False
    h.model.compliance = lambda rule, scenario: 'YES'
    h.model.harm = lambda purpose, scenario: 'UNCLEAR'
    assert h.vm.run_validator() is False
