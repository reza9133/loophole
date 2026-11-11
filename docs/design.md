# Design notes

## Why scenarios and a ratchet

A single verdict on a rule ("is this rule good?") is unfalsifiable and cannot be checked. A verdict
on a *story* can be: it is a small, concrete question with a small, closed answer set, and the
answer can be tied to quoted words. Stories also accumulate. Once a loophole is confirmed it never
goes away, so the rule can be regression-tested against everything its history has taught it.

## Two questions, kept apart

Q1 (literal compliance) and Q2 (harm to the purpose) are asked as separate questions with separate
evidence. A rule leaks exactly when the two disagree in one direction (allowed but harmful) and
overreaches when they disagree in the other (blocked but harmless). Collapsing them into one
"is this a loophole?" question would let a model's sense of the outcome decide the letter of the
rule, which is the confusion the contract exists to prevent. Q2 is asked once, at judgement time.
Amendments re-ask only Q1, because the purpose never changes.

## Evidence rules

An answer is trusted only with phrases copied from the right source. Rule words must occur in the
rule *as it is worded for this judgement* (for an amendment, the proposed wording, not the old
one). Phrases are normalised (case, whitespace, typographic quotes and dashes), need at least two
words and 8 characters, may skip words with an ellipsis (at most three pieces), and are capped in
length. An unsupported answer becomes `UNCLEAR`, never a guess.

## Consensus

The leader and every validator run the whole judgement independently. Validators must

1. be able to find every phrase the leader cited in the sources (so a leader cannot attach invented
   evidence to an answer), and
2. reproduce every definite (`YES`/`NO`) answer of the leader.

A leader answer of `UNCLEAR` is accepted whatever the validator thinks: it fails closed, and
requiring corroboration for doubt only creates rounds that cannot converge. A failed judgement (the
model errored, or returned nothing usable) agrees only with another failed judgement. The write
path re-verifies the agreed outcome once more before storing it.

## Threat model

| Threat | Mitigation |
|---|---|
| Instructions hidden in a rule, purpose or scenario | bounded length, screening for evaluator-addressed phrases and fence markers, control and invisible characters refused, fenced prompt blocks, evidence required, validators re-run independently |
| A model that is talked into a verdict | the verdict is derived by code from two bounded answers; free text never reaches state as a class; unverifiable answers are `UNCLEAR` |
| A leader that fabricates evidence | validators recheck the leader's phrases against the on-chain sources |
| Farming points with copies | near-duplicate refusal (word-trigram Jaccard >= 0.7), refuted claims cost a point |
| An owner moving the goalposts | the purpose is immutable; the ratchet re-tests all settled scenarios |
| An owner quietly re-opening a closed loophole | that scenario was `WORKING`, so reopening it is a regression and the amendment is rejected |
| Unbounded storage and prompt growth | every input and every collection is capped |
| Replaying or rewriting a judgement | attestations hash a canonical structured encoding of the rule wording at that version, the purpose, the scenario, the answers and the evidence, and can be recomputed from stored state |

## Known limits

- Verdicts are only as good as the validators' model on a given scenario. Borderline cases end
  `INCONCLUSIVE`; that is deliberate.
- The ratchet protects against regressions on the scenarios submitted so far. A rule with no
  scenarios has no protection (`UNTESTED`), and an amendment to such a rule is accepted without a
  model call.
- Collusion between an owner and challengers (easy scenarios, easy points) is not prevented; points
  are reputation, not value.
- The leaderboard tracks the first 300 distinct challengers.
