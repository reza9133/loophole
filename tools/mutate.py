"""
Mutation check: break the contract in small, plausible ways and make sure the test suite notices.

Every mutation must make at least one test fail. A mutation that survives means a rule of the
contract is not actually pinned down by the tests.

    python tools/mutate.py
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / 'contracts' / 'loophole.py'

MUTATIONS = [
    ('class table: LOOPHOLE and FINE swapped', "return CLASS_LOOPHOLE if harmful == YES else CLASS_FINE", "return CLASS_FINE if harmful == YES else CLASS_LOOPHOLE"),
    ('class table: WORKING and OVERREACH swapped', "return CLASS_WORKING if harmful == YES else CLASS_OVERREACH", "return CLASS_OVERREACH if harmful == YES else CLASS_WORKING"),
    ('claim confirmed regardless of class', "return CLAIM_CONFIRMED if klass == claim else CLAIM_REFUTED", "return CLAIM_CONFIRMED"),
    ('inconclusive claim counted as refuted', "    if klass == CLASS_INCONCLUSIVE:\n        return CLAIM_INCONCLUSIVE\n    return CLAIM_CONFIRMED", "    return CLAIM_CONFIRMED"),
    ('regression not detected', "if not was_bad and now_bad:\n        return CHANGE_REGRESSED", "if not was_bad and now_bad:\n        return CHANGE_HELD"),
    ('fixed not detected', "if was_bad and not now_bad:\n        return CHANGE_FIXED", "if was_bad and not now_bad:\n        return CHANGE_HELD"),
    ('amendment accepted despite regression', "elif regressed:\n                    result = AMENDMENT_REJECTED", "elif False:\n                    result = AMENDMENT_REJECTED"),
    ('unclear amendment answers accepted', "if unclear:\n                    result = AMENDMENT_INCONCLUSIVE", "if False:\n                    result = AMENDMENT_INCONCLUSIVE"),
    ('amend owner check removed', "if sender != rule['owner']:\n            _fail('only the owner may amend this rule')", "if False:\n            _fail('only the owner may amend this rule')"),
    ('retire owner check removed', "if _hex_of(gl.message.sender_address) != record['owner']:\n            _fail('only the owner may retire this rule')", "if False:\n            _fail('only the owner may retire this rule')"),
    ('no-op amendment allowed', "if _norm(text) == _norm(rule['text']):\n            _fail('the amendment does not change the rule text')", "if False:\n            _fail('the amendment does not change the rule text')"),
    ('retired rule can be judged', "if rule['status'] != RULE_ACTIVE:\n            _fail('rule is retired')\n\n        batch", "if False:\n            _fail('rule is retired')\n\n        batch"),
    ('retired rule accepts scenarios', "rule = self._load_rule(rule_id)\n        if rule['status'] != RULE_ACTIVE:\n            _fail('rule is retired')\n        if not isinstance(claim", "rule = self._load_rule(rule_id)\n        if not isinstance(claim"),
    ('double judging allowed', "if scenario['state'] != SCENARIO_PENDING:\n            _fail('scenario has already been judged')", "if False:\n            _fail('scenario has already been judged')"),
    ('near-duplicate gate removed', "or _similarity_permille(other['text'], text) >= DUPLICATE_PERMILLE", "or False"),
    ('duplicate threshold raised', "DUPLICATE_PERMILLE = 700", "DUPLICATE_PERMILLE = 1001"),
    ('inconclusive scenarios count toward capacity', "if other['state'] == SCENARIO_SETTLED and other['klass'] == CLASS_INCONCLUSIVE:\n                continue", "if False:\n                continue"),
    ('active scenario cap removed', "if counted >= MAX_ACTIVE_SCENARIOS:", "if False:"),
    ('stored scenario cap removed', "if len(rule['scenario_ids']) >= MAX_STORED_SCENARIOS:", "if False:"),
    ('accepted amendment cap removed', "if int(rule['accepted_amendments']) >= MAX_ACCEPTED_AMENDMENTS:", "if False:"),
    ('amendment record cap removed', "if len(rule['amendment_ids']) >= MAX_AMENDMENT_RECORDS:", "if False:"),
    ('evidence not verified for compliance', "if compliant != UNCLEAR and not (_verified(rule_words, rule_norm) and _verified(act_words, scenario_norm)):", "if False:"),
    ('evidence not verified for harm', "if harmful != UNCLEAR and not (_verified(purpose_words, purpose_norm) and _verified(effect_words, scenario_norm)):", "if False:"),
    ('rule words only checked against the scenario', "_verified(rule_words, rule_norm)", "_verified(rule_words, scenario_norm)"),
    ('purpose words checked against the rule', "_verified(purpose_words, purpose_norm)", "_verified(purpose_words, rule_norm)"),
    ('single-word evidence accepted', "    if len(' '.join(pieces).split()) < 2:\n        return False\n", ""),
    ('minimum evidence length dropped', "if total < MIN_EXCERPT_CHARS or total > MAX_EXCERPT_CHARS:", "if total > MAX_EXCERPT_CHARS:"),
    ('fragment count unbounded', "if len(pieces) == 0 or len(pieces) > MAX_FRAGMENTS:", "if len(pieces) == 0:"),
    ('missing fragment tolerated', "if len(piece) < MIN_FRAGMENT_CHARS or piece not in source_norm:\n            return False", "if len(piece) < MIN_FRAGMENT_CHARS:\n            return False"),
    ('normalisation drops case folding', "return ' '.join(text.translate(_PUNCTUATION).split()).casefold()", "return ' '.join(text.translate(_PUNCTUATION).split())"),
    ('validator ignores leader evidence', "if rechecked is None or _decisions(rechecked) != _decisions(theirs):\n        return False\n", ""),
    ('validator ignores harm answers', "return [[item['id'], item['compliant'], item.get('harmful', '')] for item in outcome['items']]", "return [[item['id'], item['compliant'], ''] for item in outcome['items']]"),
    ('validator ignores compliance answers', "return [[item['id'], item['compliant'], item.get('harmful', '')] for item in outcome['items']]", "return [[item['id'], '', item.get('harmful', '')] for item in outcome['items']]"),
    ('leader doubt needs corroboration', "return leader == mine or leader == UNCLEAR", "return leader == mine"),
    ('leader answers need no corroboration', "return leader == mine or leader == UNCLEAR", "return True"),
    ('failed judgements never agree', "return theirs.get('ok') is not True and mine.get('ok') is not True", "return False"),
    ('a failure agrees with anything', "return theirs.get('ok') is not True and mine.get('ok') is not True", "return True"),
    ('write path skips recheck', "checked = _recheck(outcome, rule['text'], rule['purpose'], batch, True)", "checked = outcome"),
    ('amendment judged against the old wording', "outcome = _run_judgement(text, rule['purpose'], batch, False)", "outcome = _run_judgement(rule['text'], rule['purpose'], batch, False)"),
    ('amendment re-asks the harm question', "outcome = _run_judgement(text, rule['purpose'], batch, False)", "outcome = _run_judgement(text, rule['purpose'], batch, True)"),
    ('accepted amendment forgets to bump version', "new_version = int(rule['version']) + 1", "new_version = int(rule['version'])"),
    ('accepted amendment forgets scenario update', "                scenario['klass'] = now_class\n                scenario['compliant_version'] = new_version", "                scenario['compliant_version'] = new_version"),
    ('rejected amendment still applies', "        if result == AMENDMENT_ACCEPTED:\n            new_version", "        if result != AMENDMENT_INCONCLUSIVE:\n            new_version"),
    ('tally not refreshed after amendment', "            rule['accepted_amendments'] = int(rule['accepted_amendments']) + 1\n            self._refresh_tally(rule)", "            rule['accepted_amendments'] = int(rule['accepted_amendments']) + 1"),
    ('tally not refreshed after judging', "        self._refresh_tally(rule)\n        self._save_rule(rule)\n        self.settled_total", "        self._save_rule(rule)\n        self.settled_total"),
    ('loophole points wrong', "POINTS_LOOPHOLE = 3", "POINTS_LOOPHOLE = 2"),
    ('refutation is free', "PENALTY_REFUTED = 1", "PENALTY_REFUTED = 0"),
    ('refuted claims not recorded', "elif scenario['claim_result'] == CLAIM_REFUTED:\n            self._bump_challenger(scenario['author'], 'refuted')", "elif scenario['claim_result'] == CLAIM_REFUTED:\n            pass"),
    ('points credited to the judge, not the author', "self._bump_challenger(scenario['author'], 'loopholes')", "self._bump_challenger(sender, 'loopholes')"),
    ('attestation ignores the verdict', "            'harmful': scenario['harmful'],\n            'class': scenario['first_class'],", "            'class': scenario['first_class'],"),
    ('attestation ignores the rule wording', "'rule_text': _digest(_text_at(rule, int(scenario['judged_version']))),", "'rule_text': _digest(''),"),
    ('amendment attestation ignores the result', "            'result': amendment['result'],\n            'results'", "            'results'"),
    ('purpose can be changed through registration key', "key = _digest({'owner': owner, 'purpose': _norm(purpose_clean), 'text': _norm(text_clean)})", "key = _digest({'owner': owner, 'text': _norm(text_clean)})"),
    ('registry ignores owner', "key = _digest({'owner': owner, 'purpose': _norm(purpose_clean), 'text': _norm(text_clean)})", "key = _digest({'purpose': _norm(purpose_clean), 'text': _norm(text_clean)})"),
    ('injection screening removed', "    for marker in _INJECTION_MARKERS:\n        if marker in lowered:\n            _fail(label + ' must describe conduct or wording, not address the evaluator')", ""),
    ('hidden characters allowed', "    if _has_hidden_character(cleaned):\n        _fail(label + ' must not contain control or invisible characters')", ""),
    ('claim not validated', "if not isinstance(claim, str) or claim not in _CLAIMS:\n            _fail('claim must be LOOPHOLE or OVERREACH')", ""),
    ('kind not validated', "if not isinstance(kind, str) or kind not in KINDS:\n            _fail('unsupported kind')", ""),
    ('health: overbroad ignored', "    if leaky and broad:\n        return HEALTH_BOTH", "    if leaky and broad:\n        return HEALTH_LEAKY"),
    ('health: untested misreported', "    if settled == 0:\n        return HEALTH_UNTESTED", "    if settled == 0:\n        return HEALTH_NO_KNOWN_FLAWS"),
    ('leaderboard sorted ascending', "records.sort(key=lambda entry: (-entry['score'], entry['address']))", "records.sort(key=lambda entry: (entry['score'], entry['address']))"),
    ('pagination off by one', "position = total - start\n        while position >= 1", "position = total - start - 1\n        while position >= 1"),
    ('missing model answer not flagged', "if scenario['id'] not in index and FLAG_MISSING not in item['flags']:", "if False:"),
    ('flags lost on recheck', "'flags_in': item.get('flags', []),", "'flags_in': [],"),
    ('answers not normalised', "cleaned = value.strip().upper()", "cleaned = value"),
    ('booleans not understood', "    if isinstance(value, bool):\n        return YES if value else NO\n", ""),
    ('ellipsis not understood', "pieces = excerpt.replace('\\u2026', '...').split('...')", "pieces = [excerpt]"),
    ('suite includes pending scenarios', "if scenario['state'] == SCENARIO_SETTLED and scenario['klass'] != CLASS_INCONCLUSIVE:\n                suite.append(scenario)", "suite.append(scenario)"),
    ('time parsing broken', "return _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second", "return _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60"),
]


def run_tests(workdir: Path) -> bool:
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', '-x', '-q', '-p', 'no:cacheprovider'],
        cwd=workdir,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def main() -> int:
    """
    Mutants are applied to a throwaway copy of the project, never to the real contract, so an
    interrupted run cannot leave the contract broken.
    """
    original = CONTRACT.read_text()
    survivors = []
    with tempfile.TemporaryDirectory(prefix='loophole-mutants-') as scratch:
        workdir = Path(scratch) / 'project'
        shutil.copytree(ROOT, workdir, ignore=shutil.ignore_patterns('node_modules', '.venv', '__pycache__', 'artifacts', 'reports', 'deployments', '.git'))
        target = workdir / 'contracts' / 'loophole.py'
        for index, (label, old, new) in enumerate(MUTATIONS, 1):
            if original.count(old) != 1:
                print('[%2d] SKIPPED (pattern occurs %d times): %s' % (index, original.count(old), label), flush=True)
                survivors.append(label + ' (pattern not unique)')
                continue
            target.write_text(original.replace(old, new))
            survived = run_tests(workdir)
            print('[%2d] %s: %s' % (index, 'SURVIVED' if survived else 'killed  ', label), flush=True)
            if survived:
                survivors.append(label)
    print()
    print('%d mutations, %d survived' % (len(MUTATIONS), len(survivors)))
    for label in survivors:
        print('  - ' + label)
    return 1 if survivors else 0


if __name__ == '__main__':
    sys.exit(main())
