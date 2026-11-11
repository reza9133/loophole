"""Pure helpers, checked directly against independent references."""

import calendar
import datetime
import json

import pytest

from conftest import bike_model
from test_04_amendments import judged_rule


def test_days_from_civil_matches_the_standard_library(h):
    mod = h.mod
    for year, month, day in [(1970, 1, 1), (1999, 12, 31), (2000, 2, 29), (2024, 2, 29), (2026, 11, 10), (2100, 3, 1), (1969, 12, 31), (1600, 2, 29)]:
        assert mod._days_from_civil(year, month, day) == (datetime.date(year, month, day) - datetime.date(1970, 1, 1)).days


@pytest.mark.parametrize(
    'stamp',
    ['2026-11-10T10:00:00Z', '2026-11-10T10:00:00', '2026-11-10 10:00:00', '2026-11-10T10:00:00.123456Z', '2026-11-10T10:00:00+00:00', '2026-11-10T10:00:00.5+0000'],
)
def test_parse_iso_formats(h, stamp):
    expected = calendar.timegm((2026, 11, 10, 10, 0, 0))
    assert h.mod._parse_iso(stamp) == expected == 1794304800


@pytest.mark.parametrize('stamp', ['', 'yesterday', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-11-32T00:00:00Z', '2026-11-10T24:00:00Z', '2026-11-10T10:60:00Z', '2026-11-10T10:00:00+05:00'])
def test_parse_iso_rejects_bad_input(h, stamp):
    with h.vm.expect_revert():
        h.mod._parse_iso(stamp)


def test_timestamps_follow_the_transaction_clock(h, data):
    rule_id = h.c.register_rule(data['rule']['title'], data['rule']['kind'], data['rule']['purpose'], data['rule']['text'])
    assert h.bundle(rule_id)['rule']['registered_at'] == 1794304800
    h.set_time('2026-11-11T00:00:05Z')
    sid = h.c.submit_scenario(rule_id, data['scenarios'][0]['text'], 'LOOPHOLE')
    assert h.scenario(sid)['submitted_at'] == 1794304800 + 14 * 3600 + 5


def test_normalisation(h):
    norm = h.mod._norm
    assert norm('  Hello\t\nWORLD  ') == 'hello world'
    assert norm('\u201cquoted\u201d \u2018it\u2019s\u2019 a\u2013b a\u2014b') == '"quoted" \'it\'s\' a-b a-b'
    assert norm('a\u00a0b') == 'a b'


def test_similarity(h):
    sim = h.mod._similarity_permille
    assert sim('the quick brown fox jumps', 'the quick brown fox jumps') == 1000
    assert sim('the quick brown fox jumps', 'THE  quick brown FOX jumps!') == 1000
    assert sim('alpha beta gamma delta', 'one two three four') == 0
    assert 0 < sim('the quick brown fox jumps over', 'the quick brown fox sleeps under') < 1000
    assert sim('', '') == 1000
    assert sim('single', 'single') == 1000 and sim('single', 'other') == 0
    assert sim('two words', 'two words') == 1000
    assert isinstance(sim('a b c d', 'a b c e'), int)


def test_fragments_and_verification(h):
    mod = h.mod
    source = mod._norm('A member may keep a bike for at most 24 consecutive hours. Returning it resets the timer.')
    ok = mod._verified
    assert ok('may keep a bike', source)
    assert ok('MAY KEEP A BIKE.', source)
    assert ok('"at most 24 consecutive hours"', source)
    assert ok('may keep ... consecutive hours', source)
    assert not ok('consecutive', source)  # one word is never enough, however long
    assert not ok('a bike', source)  # too short
    assert not ok('may keep a car', source)
    assert not ok('', source) and not ok('...', source) and not ok(None, source) and not ok(7, source) and not ok(['may keep'], source)
    assert not ok('may keep ... fly ... timer reset', source)
    assert not ok('x ... y ... z ... w', source)
    assert mod._fragments('a ... b\u2026c') == ['a', 'b', 'c']


def test_class_table(h):
    cls = h.mod._class_of
    assert cls('YES', 'YES') == 'LOOPHOLE' and cls('YES', 'NO') == 'FINE'
    assert cls('NO', 'YES') == 'WORKING' and cls('NO', 'NO') == 'OVERREACH'
    for a in ('YES', 'NO', 'UNCLEAR', ''):
        assert cls(a, 'UNCLEAR') == 'INCONCLUSIVE' and cls('UNCLEAR', a) == 'INCONCLUSIVE'
    assert cls('', '') == 'INCONCLUSIVE'


def test_change_table(h):
    change = h.mod._change_between
    assert change('LOOPHOLE', 'WORKING') == 'FIXED' and change('OVERREACH', 'FINE') == 'FIXED'
    assert change('LOOPHOLE', 'LOOPHOLE') == 'STILL_OPEN' and change('OVERREACH', 'OVERREACH') == 'STILL_OPEN'
    assert change('WORKING', 'LOOPHOLE') == 'REGRESSED' and change('FINE', 'OVERREACH') == 'REGRESSED'
    assert change('WORKING', 'WORKING') == 'HELD' and change('FINE', 'FINE') == 'HELD'


def test_digest_is_structural_not_concatenative(h):
    digest = h.mod._digest
    assert digest({'a': 'bc', 'd': 'e'}) != digest({'a': 'b', 'cd': 'e'})
    assert digest(['ab', 'c']) != digest(['a', 'bc'])
    assert digest({'x': 1, 'y': 2}) == digest({'y': 2, 'x': 1})


def test_single_word_evidence_is_refused_even_when_long_enough(h, data):
    bike_model(h.model, data)
    rule = data['rule']
    rule_id = h.c.register_rule(rule['title'], rule['kind'], rule['purpose'], rule['text'])
    sid = h.c.submit_scenario(rule_id, data['scenarios'][0]['text'], 'LOOPHOLE')

    def one_word(item, scenario):
        item['rule_words'] = 'consecutive'
        return item

    h.model.mutate_item = one_word
    assert h.c.judge_scenario(sid) == 'INCONCLUSIVE'


def test_same_wording_with_a_different_purpose_is_a_different_rule(h, data):
    rule = data['rule']
    first = h.c.register_rule(rule['title'], rule['kind'], rule['purpose'], rule['text'])
    second = h.c.register_rule(rule['title'], rule['kind'], 'Make sure that every bike is inspected after a fixed number of hours.', rule['text'])
    assert (first, second) == ('RUL-0001', 'RUL-0002')


def test_attestation_covers_the_rule_wording_and_purpose(h, data):
    rule_id, ids = judged_rule(h, data)
    stored = h.scenario(ids['loophole'])['attestation']
    rule = json.loads(h.c.rules[rule_id])
    changed = json.loads(json.dumps(rule))
    changed['history'][0]['text'] = 'A member may keep a bike for as long as they like.'
    h.c.rules[rule_id] = json.dumps(changed, sort_keys=True, separators=(',', ':'))
    assert h.c.recompute_attestation(ids['loophole']) != stored
    changed = json.loads(json.dumps(rule))
    changed['purpose'] = 'Something else entirely, written after the fact.'
    h.c.rules[rule_id] = json.dumps(changed, sort_keys=True, separators=(',', ':'))
    assert h.c.recompute_attestation(ids['loophole']) != stored
    h.c.rules[rule_id] = json.dumps(rule, sort_keys=True, separators=(',', ':'))
    assert h.c.recompute_attestation(ids['loophole']) == stored


def test_missing_answers_are_flagged_per_scenario_in_amendments(h, data):
    rule_id, ids = judged_rule(h, data)
    h.model.drop_ids = ['S2']
    assert h.c.amend_rule(rule_id, data['amendments']['good']['text']) == 'INCONCLUSIVE'
    rows = {row['scenario_id']: row for row in h.bundle(rule_id)['amendments'][0]['results']}
    assert 'MISSING' in rows[ids['overreach']]['flags']
    assert rows[ids['loophole']]['flags'] == []


def test_unsupported_answers_are_flagged_per_scenario_in_amendments(h, data):
    rule_id, ids = judged_rule(h, data)

    def only_second(item, scenario):
        if item['id'] == 'S2':
            item['rule_words'] = 'nothing in the rule says this'
        return item

    h.model.mutate_item = only_second
    assert h.c.amend_rule(rule_id, data['amendments']['good']['text']) == 'INCONCLUSIVE'
    rows = {row['scenario_id']: row for row in h.bundle(rule_id)['amendments'][0]['results']}
    assert rows[ids['overreach']]['flags'] == ['UNSUPPORTED_COMPLIANCE']
