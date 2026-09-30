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

import sentenceSet from '../../../evals/play/p32/sentences.json';
import combatLite from '../__fixtures__/combat_lite.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import { GOOD_ANSWERS, answerFixture } from '../director/__fixtures__';
import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { blockingIssues, critique } from '../director/critic';
import { direct } from '../director/index';
import { readDirectorAnswer } from '../director/read';
import { MAX_REPAIR_ROUNDS, REPAIR_RULES, applyRepairAnswer, buildRepairRequest, repairDeterministically, switchGenre } from '../director/repair';
import { draftGameSpecWithMeta } from '../draft';
import { genreDoubles } from '../genre/__tests__/doubles';
import { heroClass } from '../genre/roles';
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

/**
 * Oprava žánrové odpovědi (P32B T5) nad dvojníky modulů. Oprava, která vrátí
 * odpověď beze změny, vypadá zeleně – proto se drží, kde oprava skončí: úkol
 * nebo Aréna u čaroděje, loď u piráta, žánr draftu u slovesa, které žánry
 * neznají, a nikdy „could not fix“.
 */
describe('genre-switching repair of the director', () => {
  const text = (id: string): string => sentenceSet.sentences.find((entry) => entry.id === id)!.text;
  const answer = (spec: Record<string, unknown>) => ({ plan: 'scripted', spec });
  const run = (sentence: string, body: unknown, modules = genreDoubles()) => direct(sentence, { branch: fakeBranch([answered(body)]), now: () => 0, modules });
  const labels = (spec: GameSpecV1, kind: string): string[] => spec.roles.filter((role) => role.kind === kind).map((role) => role.label);
  const wizardOnVoyage = answer({ genre: 'voyage', mode: 'race', hero: 'wizard', collectible: 'candle', setting: 'haunted castle' });

  it('moves a wizard on a voyage with candles to the quest', async () => {
    const game = await run(text('wizard'), wizardOnVoyage);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1 });
    expect(game.failure).toBeUndefined();
    expect(game.spec.genre).toMatchObject({ id: 'quest', mode: 'spatial' });
    expect(labels(game.spec, 'player')).toEqual(['wizard']);
    expect(labels(game.spec, 'collectible')).toEqual(['candle']);
  });

  it('moves the same wizard to the arena of ghosts and candles when the quest only plays a stand-in', async () => {
    const game = await run(text('wizard'), wizardOnVoyage, genreDoubles(['quest.spatial', 'quest.station']));
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null });
    // Hra vznikla přepnutím žánru, ne pádem na draft (ten nese `failure`).
    expect(game.failure).toBeUndefined();
    expect(game.spec.genre).toMatchObject({ id: 'arena', mode: 'escape' });
    expect(labels(game.spec, 'hazard')).toEqual(['ghost']);
    expect(labels(game.spec, 'collectible')).toEqual(['candle']);
  });

  it('gives the pirate a ship instead of a race car', async () => {
    const game = await run(text('pirate'), answer({ genre: 'voyage', mode: 'race', hero: 'race car', setting: 'ocean' }));
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null });
    // Hra vznikla přepnutím žánru, ne pádem na draft (ten nese `failure`).
    expect(game.failure).toBeUndefined();
    expect(game.spec.genre).toMatchObject({ id: 'voyage', mode: 'race' });
    expect(heroClass(labels(game.spec, 'player')[0]!)).toBe('boat');
  });

  it('plays the draft genre when the sentence has a verb no genre knows', async () => {
    const sentence = 'A robot juggles oranges';
    const drafted = draftGameSpecWithMeta(sentence, 1, { modules: genreDoubles() }).genre!;
    const game = await run(sentence, answer({ genre: 'quest', mode: 'station', hero: 'robot', target: { label: 'orange', verb: 'juggle', states: 3 }, setting: 'circus' }));
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null });
    // Hra vznikla přepnutím žánru, ne pádem na draft (ten nese `failure`).
    expect(game.failure).toBeUndefined();
    expect(game.spec.genre).toMatchObject({ id: drafted.genre, mode: drafted.mode });
    expect(labels(game.spec, 'player')).toEqual(['robot']);
  });

  it('ends on the draft itself when no mode plays, never on "could not fix"', async () => {
    const modules = genreDoubles(['runner.default', 'platformer.default', 'arena.escape', 'arena.collect', 'arena.fight', 'voyage.race', 'voyage.land', 'quest.spatial', 'quest.station']);
    const game = await run(text('wizard'), wizardOnVoyage, modules);
    expect(game.spec).toEqual(draftGameSpecWithMeta(text('wizard'), 1, { modules }).spec);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, failure: { stage: 'critic', reason: 'UNFAITHFUL' } });
  });
});

/**
 * Totéž nad skutečnými moduly (B-R7). Dvojníci nemají větu, kde hlavní sloveso
 * hraje jiný režim než první v pořadí, a úkol byl pahýl – procházka pořadím
 * a větný předmět úkolu tam nešly vidět.
 */
describe('switchGenre over the real genre modules', () => {
  it('walks past the first mode of the ranking to the one the main verb plays', () => {
    // „swords“ dá souboji první místo, „make“ hraje stanice úkolu.
    const switched = switchGenre({ genre: 'arena', mode: 'fight', hero: 'fox', setting: 'meadow' }, 'merge swords to make stronger swords and fight monsters');
    expect(switched?.genre).toMatchObject({ genre: 'quest', mode: 'station', target: { label: 'sword', verb: 'make' } });
  });

  it('gives the quest the object of the sentence when the answer names none', () => {
    const wizard = sentenceSet.sentences.find((entry) => entry.id === 'wizard')!.text;
    const switched = switchGenre({ genre: 'voyage', mode: 'race', hero: 'wizard', setting: 'haunted castle' }, wizard);
    expect(switched?.genre).toMatchObject({ genre: 'quest', mode: 'spatial', target: { label: 'candle', verb: 'light' } });
  });
});
