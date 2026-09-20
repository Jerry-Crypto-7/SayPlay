/**
 * Kritik (P23-B T5). Kritik, který nikdy nic nenajde, vypadá jako čistý spec –
 * proto se drží nula blokujících nálezů nad 16 dobrými spec a devět cílených
 * mutací, každá na jeden kód. Balíčkové `ASSET_BLOCKING` / `NO_RECOVERY` se
 * nevydávají nikdy a výstup nikdy nenese skóre.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GOOD_ANSWERS, answerFixture } from '../director/__fixtures__';
import { CRITIC_CODES, UNISSUED_PACK_CODES, blockingIssues, critique, type CriticIssue } from '../director/critic';
import { ARCHETYPE_IDS } from '../registry';
import { readGameSpec, type GameSpecV1 } from '../spec';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

function base(name: string): GameSpecV1 {
  const result = readGameSpec(JSON.parse(readFileSync(new URL(`${name}.json`, `file://${fixturesDir.replace(/\\/g, '/')}`), 'utf8')));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function good(name: (typeof GOOD_ANSWERS)[number]): GameSpecV1 {
  const result = readGameSpec(answerFixture(name));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function codes(issues: readonly CriticIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

const PACK_CODES = readFileSync(fileURLToPath(new URL('../../../docs/play/pack/critic.md', import.meta.url)), 'utf8');

describe('critique', () => {
  it('issues only pack codes, never ASSET_BLOCKING or NO_RECOVERY', () => {
    for (const code of [...CRITIC_CODES, ...UNISSUED_PACK_CODES]) expect(PACK_CODES).toContain(code);
    for (const code of UNISSUED_PACK_CODES) expect(CRITIC_CODES as readonly string[]).not.toContain(code);
  });

  it('raises no blocking issue over the eight base fixtures and the eight good answers', () => {
    for (const id of ARCHETYPE_IDS) expect(blockingIssues(critique(base(id))), id).toEqual([]);
    for (const name of GOOD_ANSWERS) expect(blockingIssues(critique(good(name))), name).toEqual([]);
  });

  it('never outputs a score – no key or code mentions score or fun', () => {
    for (const name of GOOD_ANSWERS) {
      for (const issue of critique(good(name))) {
        expect(Object.keys(issue).join(' ')).not.toMatch(/score|fun/i);
        expect(issue.code).not.toMatch(/score|fun/i);
      }
    }
  });

  it('NO_AGENCY: a timer alone blocks', () => {
    const spec = clone(base('survival_timer'));
    spec.mechanics = spec.mechanics.filter((m) => m.id !== 'hazard_zone');
    spec.verification = spec.verification.filter((v) => v.mechanic !== 'hazard_zone');
    expect(codes(blockingIssues(critique(spec)))).toEqual(['NO_AGENCY']);
  });

  it('NO_TERMINATION: a zone that only signals leaves no way to win', () => {
    const spec = clone(base('collect_exit'));
    (spec.mechanics[1].params as { effect: string }).effect = 'signal';
    expect(codes(blockingIssues(critique(spec)))).toEqual(['NO_TERMINATION']);
  });

  it('CONTRADICTION: objective.count against collectible.count, and required outside switchRoles', () => {
    const spec = clone(base('collect_exit'));
    spec.objective.count = 6;
    const issues = blockingIssues(critique(spec));
    expect(codes(issues)).toEqual(['CONTRADICTION']);
    expect(issues[0].path).toBe('/mechanics/0/params/count');

    const puzzle = clone(base('switch_puzzle'));
    (puzzle.mechanics[0].params as { required: string[] }).required = ['red', 'purple'];
    expect(codes(blockingIssues(critique(puzzle)))).toEqual(['CONTRADICTION']);
  });

  it('TOO_COMPLEX: thirteen roles block', () => {
    const spec = clone(base('chase_escape'));
    for (let i = 0; i < 9; i += 1) spec.roles.push({ id: `prop${String(i)}`, kind: 'prop', label: `crate ${String(i)}`, count: 1 });
    expect(codes(blockingIssues(critique(spec)))).toEqual(['TOO_COMPLEX']);
  });

  it('UNFAIR_SPAWN: a fast chaser with no stun and no checkpoint blocks', () => {
    const spec = clone(base('chase_escape'));
    (spec.mechanics[0].params as { speed: string }).speed = 'fast';
    spec.mechanics = spec.mechanics.filter((m) => m.id !== 'stun');
    spec.verification = spec.verification.filter((v) => v.mechanic !== 'stun');
    expect(codes(blockingIssues(critique(spec)))).toEqual(['UNFAIR_SPAWN']);
  });

  it('DEAD_TIME, GOAL_UNCLEAR, UNVERIFIABLE, UNSUPPORTED and BUDGET warn without blocking', () => {
    const slow = clone(base('switch_puzzle'));
    slow.targetDurationSec = 150;
    expect(codes(critique(slow))).toContain('DEAD_TIME');
    expect(blockingIssues(critique(slow))).toEqual([]);

    const vague = clone(base('collect_exit'));
    vague.objective.description = 'Collect the mushrooms and leave.';
    expect(codes(critique(vague))).toContain('GOAL_UNCLEAR');
    expect(blockingIssues(critique(vague))).toEqual([]);

    const unverified = clone(base('collect_exit'));
    unverified.verification = unverified.verification.filter((v) => v.mechanic !== 'collectible');
    const issue = critique(unverified).find((entry) => entry.code === 'UNVERIFIABLE');
    expect(issue?.path).toBe('/mechanics/0');
    expect(blockingIssues(critique(unverified))).toEqual([]);

    const fantasy = clone(base('combat_lite'));
    fantasy.objective.description = 'Shoot all five slimes with energy balls.';
    expect(critique(fantasy).find((entry) => entry.code === 'UNSUPPORTED')?.severity).toBe('warn');

    const tight = clone(base('collect_exit'));
    tight.budgets.maxEntities = 8;
    expect(critique(tight).find((entry) => entry.code === 'BUDGET')?.severity).toBe('warn');
  });
});
