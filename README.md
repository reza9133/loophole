# Loophole

**Regression tests for rules.** A GenLayer Intelligent Contract for Studionet.

A rule is only as good as the worst case it gets wrong, and rules fail in two directions:

- a clever reader satisfies the words while defeating the point: a **loophole**;
- the words block something that harms nobody: an **overreach**.

Loophole turns both kinds of failure into permanent, checkable test cases, and then refuses to let
the rule be reworded in a way that breaks a case it used to handle. Think of it as a test suite for
house rules, policies, bylaws, game rules, terms and protocols.

> Loophole is a record-keeper and adjudicator for short texts. It holds no value and moves no
> value. Its verdicts are about wording and conduct, not legal advice.

## How it works

A **rule** has a frozen **purpose** (why it exists) and a revisable **text** (the exact words).
Anyone can submit a **scenario**, a short story about conduct, together with a claim:
`LOOPHOLE` or `OVERREACH`. Validators then answer two independent questions about it.

| Question | Read | Answers |
|---|---|---|
| Q1 *compliant* | only the literal words of the rule, like a strict clerk | `YES` (allowed by the letter), `NO` (breach), `UNCLEAR` |
| Q2 *harmful* | only the purpose, ignoring the words | `YES` (works against the purpose), `NO`, `UNCLEAR` |

The contract, not the model, derives the class:

|  | harmful = YES | harmful = NO |
|---|---|---|
| **compliant = YES** | `LOOPHOLE` (the rule leaks) | `FINE` |
| **compliant = NO** | `WORKING` (the rule catches it) | `OVERREACH` (the rule blocks harmless conduct) |

Anything with an `UNCLEAR` answer is `INCONCLUSIVE` and counts for nothing.

### The ratchet

The owner may reword a rule, never its purpose. `amend_rule` re-runs Q1 for **every settled
scenario** under the proposed wording and applies one rule:

> a scenario that was handled correctly (`WORKING`, `FINE`) must still be handled correctly.

Fixing loopholes is welcome, and failures that were already open may stay open, but the set of
known failures can never *grow* through an amendment. Reopening a closed loophole is a regression,
and so is a "fix" that starts blocking harmless conduct. The result is `ACCEPTED`, `REJECTED` (with
the regressions named) or `INCONCLUSIVE` (an answer could not be verified, the rule is unchanged).

### Scoring

A confirmed `LOOPHOLE` claim earns 3 points, a confirmed `OVERREACH` claim 2, a refuted claim costs 1,
an inconclusive one changes nothing. Near-duplicates of an existing scenario are refused, so one
discovery cannot be farmed.

## Why the contract is trustworthy

The model proposes, the contract disposes.

- **A model only chooses `YES`, `NO` or `UNCLEAR` and cites phrases.** Classes, claim results,
  points, regressions and acceptance are computed by code.
- **Every answer is evidence-checked.** The model must copy a short phrase from the right source
  (rule words from the rule, purpose words from the purpose, conduct words from the scenario). The
  contract verifies each phrase verbatim (case, whitespace and typographic quotes are tolerated,
  ellipses may skip words). An answer whose phrases cannot be found is demoted to `UNCLEAR`.
  Nothing unverifiable is ever counted as a finding.
- **Untrusted text is screened and fenced.** Rules, purposes and scenarios are length-bounded,
  refused if they contain control or invisible characters, text that addresses the evaluator
  ("ignore previous instructions", fence markers, ...), and are fenced inside the prompt.
- **Consensus is strict where it matters.** Validators independently repeat the whole judgement and
  re-verify the leader's cited phrases. Every *definite* answer of the leader must be reproduced.
  Doubt (`UNCLEAR`) needs no corroboration because it fails closed, so a cautious leader cannot
  stall a round. Disagreement writes nothing.
- **The purpose is immutable.** A rule cannot be made to pass its own tests by moving its goal.
- **Everything is attested.** Each judgement and amendment stores a digest of a canonical
  structured encoding of what it rests on, and a view recomputes it from stored state.

## Contract API

Writes

| Method | Who | What |
|---|---|---|
| `register_rule(title, kind, purpose, rule_text)` | anyone | freeze a purpose and the first wording; returns `RUL-0001` |
| `submit_scenario(rule_id, scenario_text, claim)` | anyone | queue a scenario; deterministic gates only; returns `SCN-0001` |
| `judge_scenario(scenario_id)` | anyone | run the judgement; returns the class or `INCONCLUSIVE` |
| `amend_rule(rule_id, new_text)` | owner | propose new wording; the ratchet decides |
| `retire_rule(rule_id)` | owner | stop testing a rule; history stays on chain |

Views (all return JSON text unless noted): `contract_info`, `stats`, `list_rules(offset, limit)`,
`get_rule_bundle(rule_id)`, `get_scenario_bundle(scenario_id)`, `health_of(rule_id)` (plain text:
`UNTESTED`, `NO_KNOWN_FLAWS`, `LEAKY`, `OVERBROAD`, `LEAKY_AND_OVERBROAD`), `challenger_record(address)`,
`top_challengers(limit)`, `recompute_attestation(scenario_id)`, `recompute_amendment_attestation(amendment_id)`.

Limits: purpose 20-300 characters, rule 20-800, scenario 30-500, title 3-100; at most 10 live
scenarios and 20 stored attempts per rule; at most 12 accepted amendments and 20 amendment records
per rule; the leaderboard tracks the first 300 challengers. Failed (`INCONCLUSIVE`) scenarios do not
use up the allowance and can be resubmitted.

## Run everything

You need `python3` (3.10+) and `node` (20+). In a GitHub Codespace both are already there.

```bash
bash run.sh
```

That sets up a virtualenv and `node_modules`, lints the contract, runs all offline tests, deploys a
fresh contract to **Studionet**, runs the live end-to-end lifecycle, and writes a report to
`reports/e2e-<timestamp>.md` (plus a `.json` with the raw data). Studionet needs no funds: the
scripts use throwaway accounts. The live part takes roughly 10 to 25 minutes because every
judgement runs a model on several validators.

Useful variations

```bash
bash run.sh --offline            # setup + lint + offline tests, no network
bash run.sh --skip-tests         # straight to deploy + live e2e
bash run.sh --address 0x...      # live e2e against an existing deployment
bash run.sh --wait-final         # also wait until every transaction is FINALIZED
bash run.sh --strict             # model deviations fail the run too
bash run.sh --mutate             # also run the mutation check (about 3 minutes)
npm run deploy:contract          # deploy only; writes deployments/studionet.json
```

### What the live run does

Three throwaway accounts (owner, alice, bob) take a bike-share rule ("keep a bike at most 24
consecutive hours; returning it to a dock resets the timer", purpose "keep bikes circulating") through
the whole lifecycle:

1. register the rule;
2. five writes the contract must **reject** (stranger amending, duplicate registration, a scenario that
   addresses the evaluator, a too-short scenario, a claim outside the vocabulary);
3. submit four scenarios that cover all four classes, plus a near-duplicate that must be refused;
4. judge them (an inconclusive judgement is resubmitted and judged again, as a real user would);
5. check the rule's tally and health, and every challenger's record, against the settled scenarios;
6. an amendment that should be **accepted** (closes the loophole) and one that the ratchet must
   **reject** (a one-hour limit breaks the ordinary two-hour ride);
7. retire the rule and confirm that it refuses further writes;
8. check the contract-wide totals.

The report separates two kinds of checks. **Invariants** are guarantees that hold whatever the model
says (class derived from the answers, claim results, scoring, attestations, the ratchet, rejections,
totals). **Expectations** are what a sensible model should say about each scenario. A deviation shows
how borderline a scenario is, not that the contract is wrong. Only invariants decide pass or fail
(`--strict` includes expectations).

## Tests

All of this runs offline, from `bash run.sh --offline`, and in CI.

| Layer | What it proves |
|---|---|
| `tests/` (pytest, 167 tests) | The real contract file runs on the real GenVM Python SDK (the GenLayer direct runner) with a scripted model: gates, all four classes, scoring, evidence verification, malformed and hostile model output, validator equivalence, the ratchet, caps, attestations, helpers checked against independent references. |
| `tools/mutate.py` (69 mutations) | Breaks the contract in small plausible ways (a swapped class, a removed owner check, a disabled ratchet, a skipped evidence check, ...). Every mutation must make a test fail. |
| `tests/node/` (22 tests) | The live e2e script, rehearsed end to end against the real contract through `tools/bridge.py` with a faithful, hesitant, contrarian, chaotic (broken evidence) and unavailable model. A faithful model passes everything; no model, however bad, can make an invariant fail; and a contract with a disabled ratchet makes the rehearsal fail. |

What offline testing cannot show is how the real validators' model behaves on your scenarios. That
is exactly what the live run measures.

## Layout

```
contracts/loophole.py      the intelligent contract
scripts/deploy.mjs         deploy to Studionet and verify
scripts/e2e.mjs            live end-to-end lifecycle (also driven offline by the rehearsal)
scripts/e2e-lib.mjs        independent restatement of the rules, invariant checks, report
scripts/e2e-data.json      the rule, scenarios and amendments used by the e2e (and the tests)
tests/                     pytest suite (+ tests/node for the scripts)
tools/mutate.py            mutation check
tools/bridge.py            offline stand-in for the network, used by the rehearsal
docs/design.md             design decisions and threat model
run.sh                     one command for everything
```

## Notes

- Deployments are recorded in `deployments/` (not `artifacts/`, which the Python test plugin clears).
- The contract pins the Studionet runner in its first line. Do not edit that line.
- Scenario judgements depend on the validators' model. Write scenarios as plain conduct, one idea
  each; borderline cases will come back `INCONCLUSIVE`, which is the intended, safe outcome.
