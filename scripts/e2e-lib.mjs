// Pure helpers for the live end-to-end run: the contract's own rules restated independently (so the
// run can check the contract against them), invariant checks, and the Markdown report. No network
// and no SDK import, so everything here is unit tested offline.

export const POINTS = { LOOPHOLE: 3, OVERREACH: 2, REFUTED: 1 };
export const GOOD = new Set(['WORKING', 'FINE']);
export const BAD = new Set(['LOOPHOLE', 'OVERREACH']);

/** The class table, restated independently of the contract. */
export function classOf(compliant, harmful) {
  if (!['YES', 'NO'].includes(compliant) || !['YES', 'NO'].includes(harmful)) return 'INCONCLUSIVE';
  if (compliant === 'YES') return harmful === 'YES' ? 'LOOPHOLE' : 'FINE';
  return harmful === 'YES' ? 'WORKING' : 'OVERREACH';
}

export function claimResultOf(claim, klass) {
  if (klass === 'INCONCLUSIVE') return 'INCONCLUSIVE';
  return klass === claim ? 'CONFIRMED' : 'REFUTED';
}

export function healthOf(tally) {
  const settled = (tally.LOOPHOLE ?? 0) + (tally.WORKING ?? 0) + (tally.OVERREACH ?? 0) + (tally.FINE ?? 0);
  if (settled === 0) return 'UNTESTED';
  const leaky = (tally.LOOPHOLE ?? 0) > 0;
  const broad = (tally.OVERREACH ?? 0) > 0;
  if (leaky && broad) return 'LEAKY_AND_OVERBROAD';
  if (leaky) return 'LEAKY';
  if (broad) return 'OVERBROAD';
  return 'NO_KNOWN_FLAWS';
}

/** Key order is not meaningful: the contract stores canonical (sorted) JSON. */
export function sameTally(left, right) {
  return ['LOOPHOLE', 'WORKING', 'OVERREACH', 'FINE'].every((name) => (left?.[name] ?? 0) === (right?.[name] ?? 0));
}

export function tallyOf(scenarios) {
  const tally = { LOOPHOLE: 0, WORKING: 0, OVERREACH: 0, FINE: 0 };
  for (const scenario of scenarios) {
    if (scenario.state === 'SETTLED' && scenario.klass in tally) tally[scenario.klass] += 1;
  }
  return tally;
}

/** Expected per-author counts from settled scenarios: what challenger_record must say. */
export function expectedChallengers(scenarios) {
  const book = {};
  for (const scenario of scenarios) {
    if (scenario.state !== 'SETTLED') continue;
    const entry = (book[scenario.author] ??= { loopholes: 0, overreaches: 0, refuted: 0, inconclusive: 0 });
    if (scenario.claim_result === 'CONFIRMED') entry[scenario.first_class === 'LOOPHOLE' ? 'loopholes' : 'overreaches'] += 1;
    else if (scenario.claim_result === 'REFUTED') entry.refuted += 1;
    else entry.inconclusive += 1;
  }
  for (const entry of Object.values(book)) entry.score = POINTS.LOOPHOLE * entry.loopholes + POINTS.OVERREACH * entry.overreaches - POINTS.REFUTED * entry.refuted;
  return book;
}

export class Checks {
  constructor() {
    this.items = [];
  }

  /** An invariant: a property the contract guarantees whatever the model says. */
  invariant(area, name, ok, detail = '') {
    this.items.push({ kind: 'invariant', area, name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  }

  /** An expectation: what a sensible model should say. A deviation is reported, not fatal. */
  expectation(area, name, ok, detail = '') {
    this.items.push({ kind: 'expectation', area, name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  }

  get failedInvariants() {
    return this.items.filter((item) => item.kind === 'invariant' && !item.ok);
  }

  get deviations() {
    return this.items.filter((item) => item.kind === 'expectation' && !item.ok);
  }

  counts() {
    const invariants = this.items.filter((item) => item.kind === 'invariant');
    const expectations = this.items.filter((item) => item.kind === 'expectation');
    return {
      invariants: invariants.length,
      invariantsPassed: invariants.filter((item) => item.ok).length,
      expectations: expectations.length,
      expectationsMet: expectations.filter((item) => item.ok).length,
    };
  }
}

/** Invariants of one judged scenario, checked against the contract's published rules. */
export function checkScenario(checks, scenario, { attestation, judge, label }) {
  const area = label;
  checks.invariant(area, 'scenario is settled', scenario.state === 'SETTLED', scenario.state);
  checks.invariant(area, 'class is derived from the two answers', scenario.first_class === classOf(scenario.first_compliant, scenario.harmful), `${scenario.first_compliant}/${scenario.harmful} -> ${scenario.first_class}`);
  checks.invariant(area, 'claim result follows from class and claim', scenario.claim_result === claimResultOf(scenario.claim, scenario.first_class), `${scenario.claim} vs ${scenario.first_class} -> ${scenario.claim_result}`);
  checks.invariant(area, 'attestation recomputes from stored state', attestation === scenario.attestation && /^0x[0-9a-f]{64}$/.test(scenario.attestation), scenario.attestation);
  checks.invariant(area, 'judge is recorded', scenario.evaluated_by === judge, scenario.evaluated_by);
  if (scenario.first_class !== 'INCONCLUSIVE') {
    const evidence = scenario.evidence ?? {};
    const phrases = ['rule_words', 'act_words', 'purpose_words', 'effect_words'].map((name) => String(evidence[name] ?? ''));
    checks.invariant(area, 'a conclusive finding cites all four phrases', phrases.every((text) => text.length >= 8), phrases.map((text) => text.length).join('/'));
    checks.invariant(area, 'a conclusive finding has no flags', (scenario.flags ?? []).length === 0, (scenario.flags ?? []).join(','));
  } else {
    checks.invariant(area, 'an inconclusive scenario records why', Boolean(scenario.failure_reason), scenario.failure_reason);
  }
}

/** The ratchet, restated from first principles and checked against before/after snapshots. */
export function checkAmendment(checks, { label, before, after, amendment, proposedText }) {
  const area = label;
  const result = amendment.result;
  checks.invariant(area, 'result is one of ACCEPTED, REJECTED, INCONCLUSIVE', ['ACCEPTED', 'REJECTED', 'INCONCLUSIVE'].includes(result), result);
  checks.invariant(area, 'the amendment records the version it was tested against', amendment.base_version === before.rule.version, String(amendment.base_version));

  const beforeById = Object.fromEntries(before.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
  const afterById = Object.fromEntries(after.scenarios.map((scenario) => [scenario.scenario_id, scenario]));

  if (result === 'ACCEPTED') {
    checks.invariant(area, 'accepted: version moved by exactly one', after.rule.version === before.rule.version + 1, `${before.rule.version} -> ${after.rule.version}`);
    checks.invariant(area, 'accepted: the rule text is the proposed text', after.rule.text === proposedText);
    checks.invariant(area, 'accepted: history gained the new wording', after.rule.history.length === before.rule.history.length + 1 && after.rule.history.at(-1).text === proposedText);
    checks.invariant(area, 'accepted: the purpose is untouched', after.rule.purpose === before.rule.purpose);
    let ratchetHolds = true;
    const broken = [];
    for (const [id, was] of Object.entries(beforeById)) {
      const now = afterById[id];
      if (was.state === 'SETTLED' && GOOD.has(was.klass) && !GOOD.has(now.klass)) {
        ratchetHolds = false;
        broken.push(id);
      }
    }
    checks.invariant(area, 'accepted: no scenario that worked was broken (the ratchet)', ratchetHolds, broken.join(','));
    checks.invariant(area, 'accepted: no regression is recorded', (amendment.regressions ?? []).length === 0, (amendment.regressions ?? []).join(','));
    const rowsAgree = (amendment.results ?? []).every((row) => afterById[row.scenario_id]?.klass === row.now);
    checks.invariant(area, 'accepted: stored classes match the recorded results', rowsAgree);
    checks.invariant(area, 'accepted: tally matches the stored classes', sameTally(after.rule.tally, tallyOf(after.scenarios)));
  } else {
    checks.invariant(area, `${result.toLowerCase()}: version and text are unchanged`, after.rule.version === before.rule.version && after.rule.text === before.rule.text);
    const unchanged = before.scenarios.every((scenario) => afterById[scenario.scenario_id].klass === scenario.klass && afterById[scenario.scenario_id].compliant === scenario.compliant);
    checks.invariant(area, `${result.toLowerCase()}: no scenario was reclassified`, unchanged);
    if (result === 'REJECTED') {
      const regs = amendment.regressions ?? [];
      checks.invariant(area, 'rejected: names at least one regression', regs.length > 0);
      checks.invariant(area, 'rejected: every named regression was working and is now failing', regs.every((id) => {
        const row = (amendment.results ?? []).find((entry) => entry.scenario_id === id);
        return row && GOOD.has(beforeById[id].klass) && BAD.has(row.now);
      }));
    }
  }
}

export function checkChallengers(checks, { scenarios, records, top }) {
  const expected = expectedChallengers(scenarios);
  for (const [address, entry] of Object.entries(expected)) {
    const record = records[address];
    const same = record && ['loopholes', 'overreaches', 'refuted', 'inconclusive', 'score'].every((field) => record[field] === entry[field]);
    checks.invariant('challengers', `record of ${address.slice(0, 10)} matches its settled scenarios`, same, JSON.stringify(record));
  }
  const scores = top.items.map((item) => item.score);
  checks.invariant('challengers', 'leaderboard is sorted by score, highest first', scores.every((value, index) => index === 0 || scores[index - 1] >= value), scores.join(','));
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(run) {
  const counts = run.checks.counts();
  const verdict = run.checks.failedInvariants.length === 0 ? 'PASS' : 'FAIL';
  const lines = [];
  lines.push('# Loophole - live end-to-end report');
  lines.push('');
  lines.push(`**Verdict: ${verdict}.** ${counts.invariantsPassed}/${counts.invariants} contract invariants held. ${counts.expectationsMet}/${counts.expectations} model expectations were met.`);
  lines.push('');
  lines.push('An *invariant* is something the contract guarantees whatever the validators\' model says (class derived from answers, ratchet, scoring, attestations, rejections). An *expectation* is what a sensible model should say about a scenario; a deviation is reported but is not a contract fault.');
  lines.push('');
  lines.push('## Run');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Network | ${cell(run.network)} |`);
  lines.push(`| RPC | ${cell(run.rpc)} |`);
  lines.push(`| Contract | \`${cell(run.contract.address)}\` |`);
  lines.push(`| Deployed in this run | ${run.contract.deployedHere ? 'yes (tx `' + cell(run.contract.deployTransaction) + '`)' : 'no (attached to an existing contract)'} |`);
  lines.push(`| Contract version | ${cell(run.contract.version)} |`);
  lines.push(`| Source sha256 | \`${cell(run.contract.sourceSha256)}\` |`);
  lines.push(`| Runner | \`${cell(run.contract.runner)}\` |`);
  lines.push(`| Accounts | ${Object.entries(run.accounts).map(([name, address]) => `${name} \`${address}\``).join(', ')} |`);
  lines.push(`| Started | ${cell(run.startedAt)} |`);
  lines.push(`| Finished | ${cell(run.finishedAt)} |`);
  lines.push(`| Duration | ${Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)} s |`);
  lines.push('');

  lines.push('## Transactions');
  lines.push('');
  lines.push('| # | Step | From | Method | Outcome | Decision | Finality | Seconds | Transaction |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  run.steps.forEach((step, index) => {
    lines.push(`| ${index + 1} | ${cell(step.label)} | ${cell(step.who)} | \`${cell(step.fn)}\` | ${cell(step.outcome)} | ${cell(step.statusName)} | ${cell(step.finality ?? '-')} | ${step.seconds ?? '-'} | \`${cell(step.hash)}\` |`);
  });
  lines.push('');

  if (run.scenarios.length > 0) {
    lines.push('## Scenarios');
    lines.push('');
    lines.push('| Scenario | Key | Claim | Compliant | Harmful | Class | Claim result | Expected class | Attempt |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const entry of run.scenarios) {
      const s = entry.record;
      lines.push(`| ${cell(s.scenario_id)} | ${cell(entry.key)} | ${cell(s.claim)} | ${cell(s.first_compliant)} | ${cell(s.harmful)} | ${cell(s.first_class)} | ${cell(s.claim_result)} | ${cell(entry.expectedClass)} | ${entry.attempt} |`);
    }
    lines.push('');
  }

  if (run.amendments.length > 0) {
    lines.push('## Amendments');
    lines.push('');
    for (const entry of run.amendments) {
      const a = entry.record;
      lines.push(`### ${entry.label}: ${a.result}  (expected ${entry.expectedResult})`);
      lines.push('');
      lines.push(`> ${cell(a.text)}`);
      lines.push('');
      lines.push(`Fixed: ${a.fixed.join(', ') || 'none'}. Still open: ${a.still_open.join(', ') || 'none'}. Regressions: ${a.regressions.join(', ') || 'none'}. Note: ${a.note || '-'}.`);
      lines.push('');
      if (a.results.length > 0) {
        lines.push('| Scenario | Was | Now | Change |');
        lines.push('|---|---|---|---|');
        for (const row of a.results) lines.push(`| ${cell(row.scenario_id)} | ${cell(row.was)} | ${cell(row.now)} | ${cell(row.change)} |`);
        lines.push('');
      }
    }
  }

  lines.push('## Final state of the rule');
  lines.push('');
  if (run.finalRule) {
    lines.push(`Version ${run.finalRule.version}, status ${run.finalRule.status}, health ${run.finalRule.health}, tally \`${JSON.stringify(run.finalRule.tally)}\`.`);
    lines.push('');
  }
  if (run.leaderboard) {
    lines.push('Leaderboard:');
    lines.push('');
    lines.push('| Address | Loopholes | Overreaches | Refuted | Inconclusive | Score |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of run.leaderboard) lines.push(`| \`${cell(item.address)}\` | ${item.loopholes} | ${item.overreaches} | ${item.refuted} | ${item.inconclusive} | ${item.score} |`);
    lines.push('');
  }

  lines.push('## Checks');
  lines.push('');
  lines.push('| Kind | Area | Check | Result | Detail |');
  lines.push('|---|---|---|---|---|');
  for (const item of run.checks.items) {
    lines.push(`| ${item.kind} | ${cell(item.area)} | ${cell(item.name)} | ${item.ok ? 'ok' : (item.kind === 'invariant' ? '**FAILED**' : 'deviation')} | ${cell(item.detail)} |`);
  }
  lines.push('');
  if (run.checks.deviations.length > 0) {
    lines.push('## Model deviations');
    lines.push('');
    lines.push('These are differences between what the validators\' model said and what a sensible reader would say. The contract handled every one of them correctly (see the invariants); a deviation shows how borderline a scenario is, not that the contract is wrong.');
    lines.push('');
    for (const item of run.checks.deviations) lines.push(`- ${item.area}: ${item.name} (${item.detail})`);
    lines.push('');
  }
  return lines.join('\n');
}
