/**
 * Oprava (P23-B T6). Oprava, která vrací vstup beze změny, projde
 * `readGameSpec` u dobrých spec a vypadá zeleně – proto se drží čtyři
 * skutečné opravy rozbitých odpovědí (pin naměřený 20. 9. 2026: 4 z 5 JSON
 * fixtur, useknutý text a WorldDoc dají `null`) a odmítnutí špatných RFC 6902
 * odpovědí.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import combatLite from '../__fixtures__/combat_lite.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import { GOOD_ANSWERS, answerFixture } from '../director/__fixtures__';
import { blockingIssues, critique } from '../director/critic';
import { readDirectorAnswer } from '../director/read';
import { MAX_REPAIR_ROUNDS, REPAIR_RULES, applyRepairAnswer, buildRepairRequest, repairDeterministically } from '../director/repair';
import { readGameSpec, type GameSpecV1 } from '../spec';

const RULES_FILE = fileURLToPath(new URL('../../../docs/play/pack/repair.md', import.meta.url));

function good(name: (typeof GOOD_ANSWERS)[number]): GameSpecV1 {
  const result = readGameSpec(answerFixture(name));
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function repairRead(name: Parameters<typeof answerFixture>[0]) {
  const body = answerFixture(name);
  const read = readDirectorAnswer(body);
  if (read.ok) throw new Error(`${name} unexpectedly readable`);
  return repairDeterministically(body, read.reason);
}

describe('repairDeterministically over the reader reasons', () => {
  it('repairs four of the five broken JSON answers (pin) and refuses the WorldDoc', () => {
    const unknown = repairRead('bad-unknown-mechanic');
    expect(unknown?.spec.mechanics.map((m) => m.id)).toEqual(['defeat', 'health']);
    expect(unknown?.applied.join('\n')).toContain('projectile');

    const noPlayer = repairRead('bad-no-player');
    expect(noPlayer?.spec.roles.filter((role) => role.kind === 'player')).toHaveLength(1);

    const foreign = repairRead('bad-foreign-archetype');
    expect(foreign?.spec.mechanics.map((m) => m.id)).toEqual(['switch', 'zone_trigger']);

    const budget = repairRead('bad-over-budget');
    // P26 T3: rozpočet modelu se nejdřív zvedne k mezi registru, 22 vozíků se do ní vejde.
    expect(budget?.spec.roles.find((role) => role.id === 'bookcart')?.count).toBe(22);
    expect(budget?.applied[0]).toMatch(/^budgets raised to/);

    expect(repairRead('bad-worlddoc')).toBeNull();
    expect(repairDeterministically(undefined, 'NOT_AN_OBJECT')).toBeNull();
    expect([unknown, noPlayer, foreign, budget].filter((r) => r !== null)).toHaveLength(4);
  });

  it('leaves every repaired spec free of blocking critic issues', () => {
    for (const name of ['bad-unknown-mechanic', 'bad-no-player', 'bad-foreign-archetype', 'bad-over-budget'] as const) {
      const repaired = repairRead(name);
      expect(repaired, name).not.toBeNull();
      if (repaired !== null) expect(blockingIssues(critique(repaired.spec)), name).toEqual([]);
    }
  });
});

describe('repairDeterministically over critic issues', () => {
  it('NO_TERMINATION: turns the signalling zone into the win, or adds an exit', () => {
    const spec = clone(good('good-collect_exit'));
    (spec.mechanics[1].params as { effect: string }).effect = 'signal';
    const repaired = repairDeterministically(spec, critique(spec));
    expect(repaired?.spec.mechanics[1].params.effect).toBe('win');
    expect(blockingIssues(critique(repaired?.spec as GameSpecV1))).toEqual([]);
  });

  it('CONTRADICTION and UNFAIR_SPAWN: numbers follow the mechanic, the chaser slows down', () => {
    const spec = clone(good('good-collect_exit'));
    spec.objective.count = 3;
    expect(repairDeterministically(spec, critique(spec))?.spec.objective.count).toBe(8);

    const chase = clone(good('good-chase_escape'));
    (chase.mechanics[0].params as { speed: string }).speed = 'fast';
    chase.mechanics = chase.mechanics.filter((m) => m.id !== 'stun');
    chase.verification = chase.verification.filter((v) => v.mechanic !== 'stun');
    expect(repairDeterministically(chase, critique(chase))?.spec.mechanics[0].params.speed).toBe('normal');
  });

  it('TOO_COMPLEX: drops spice mechanics from the end, keeps the required ones', () => {
    const spec = clone(good('good-chase_escape'));
    spec.mechanics.push({ id: 'health', params: { max: 3 } }, { id: 'timer', params: { id: 'clock', seconds: 60, onEnd: 'lose' } });
    const repaired = repairDeterministically(spec, critique(spec));
    expect(repaired?.spec.mechanics).toHaveLength(4);
    expect(repaired?.spec.mechanics.map((m) => m.id)).toEqual(['chaser', 'zone_trigger', 'stun', 'health']);
  });

  it('UNVERIFIABLE: adds a keypoint from the fixture template with this spec\'s roles and counters', () => {
    const spec = clone(good('good-collect_exit'));
    spec.verification = spec.verification.filter((v) => v.mechanic !== 'collectible');
    const repaired = repairDeterministically(spec, critique(spec));
    const keypoint = repaired?.spec.verification.find((v) => v.mechanic === 'collectible');
    expect(keypoint?.actions?.[0].target).toBe('coin');
    expect(keypoint?.setup?.counters).toEqual({ coins: 7 });
    expect(keypoint?.assert.counters).toEqual({ coins: 8 });
  });

  it('returns null when there is nothing to apply', () => {
    const spec = good('good-switch_puzzle');
    expect(repairDeterministically(spec, [])).toBeNull();
  });
});

/** Tři příčiny z běhu `2026-09-23-t5` (P26 T3), každá zmenšená na jednu vadu nad šablonou. */
describe('repairDeterministically over the measured upgrade failures', () => {
  function readRepair(body: Record<string, unknown>) {
    const read = readDirectorAnswer(body);
    if (read.ok) throw new Error('unexpectedly readable');
    return { reason: read.reason, repaired: repairDeterministically(body, read.reason) };
  }

  it('fills a missing objective count from the target role and adds no grid keypoints to an arcade game', () => {
    const body = clone(shooter) as Record<string, unknown> & { objective: Record<string, unknown> };
    body.mechanics = [{ id: 'health', params: { max: 3 } }];
    delete body.objective.count;
    const { reason, repaired } = readRepair(body);
    expect(reason).toBe('OBJECTIVE_MISMATCH');
    expect(repaired?.spec.objective.count).toBe(4);
    expect(repaired?.spec.verification).toEqual(shooter.verification);
  });

  it('drops the second copy of a mechanic declared twice', () => {
    const body = clone(combatLite) as Record<string, unknown> & { mechanics: unknown[] };
    body.mechanics = [...body.mechanics, { id: 'health', params: { max: 5 } }];
    const { reason, repaired } = readRepair(body);
    expect(reason).toBe('DANGLING_REFERENCE');
    expect(repaired?.spec.mechanics.map((mechanic) => mechanic.id)).toEqual(['defeat', 'health']);
  });

  it('raises a too small budget to the registry limit before shrinking the game', () => {
    const body = clone(combatLite) as Record<string, unknown>;
    body.budgets = { maxEntities: 2, maxRules: 3, maxTriangles: 200000 };
    const { reason, repaired } = readRepair(body);
    expect(reason).toBe('BUDGET_EXCEEDED');
    expect(repaired?.spec.objective.count).toBe(5);
    expect(repaired?.spec.budgets.maxEntities).toBeGreaterThan(2);
  });

  it('does not charge an arcade game with the grid cost estimate', () => {
    const body = clone(shooter) as Record<string, unknown>;
    body.budgets = { maxEntities: 2, maxRules: 1, maxTriangles: 200000 };
    expect(readGameSpec(body).ok).toBe(true);
  });
});

describe('model repair round', () => {
  it('quotes the pack rules verbatim and asks for operations over the spec and issues', () => {
    expect(REPAIR_RULES).toBe(readFileSync(RULES_FILE, 'utf8').trim());
    expect(MAX_REPAIR_ROUNDS).toBe(2);
    const spec = good('good-delivery');
    const request = buildRepairRequest(spec, critique(spec));
    expect(request.system).toContain('RFC 6902');
    expect(request.system).toContain('- carry {');
    expect(request.user).toContain('SPEC:\n{"schema":"gamespec.v1"');
    expect(request.user).toContain('ISSUES:\n[');
  });

  it('applies a good patch and refuses a missing path, a /schema edit and a non-array', () => {
    const spec = good('good-combat_lite');
    const applied = applyRepairAnswer(spec, [{ op: 'replace', path: '/title', value: 'Dojo Sweep' }]);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.spec.title).toBe('Dojo Sweep');
    expect(spec.title).toBe('Dojo Dummies');

    const missing = applyRepairAnswer(spec, [{ op: 'replace', path: '/mechanics/7/params/count', value: 2 }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('PATCH_FAILED');

    const schema = applyRepairAnswer(spec, [{ op: 'replace', path: '/schema', value: 'gamespec.v2' }]);
    expect(schema.ok).toBe(false);
    if (!schema.ok) expect(schema.reason).toBe('SCHEMA_TOUCHED');
    // Schéma se nesmí ani přesunout jinam, ani přepsat celým dokumentem.
    for (const operation of [
      { op: 'move', from: '/schema', path: '/title' },
      { op: 'copy', from: '/schema', path: '/title' },
      { op: 'replace', path: '', value: {} },
      { op: 'replace', path: '/', value: {} },
    ]) {
      const touched = applyRepairAnswer(spec, [operation]);
      expect(touched, JSON.stringify(operation)).toMatchObject({ ok: false, reason: 'SCHEMA_TOUCHED' });
    }

    const object = applyRepairAnswer(spec, { op: 'replace', path: '/title', value: 'x' });
    expect(object.ok).toBe(false);
    if (!object.ok) expect(object.reason).toBe('NOT_AN_ARRAY');

    const invalid = applyRepairAnswer(spec, [{ op: 'replace', path: '/objective/count', value: 99 }]);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('MALFORMED_SPEC');
  });
});
