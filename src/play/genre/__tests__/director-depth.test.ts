/**
 * Režisér nastaví hloubku hry (P36A T8): životy, cílové skóre, časový limit
 * a chování nepřítele v odpovědi `GenreSpec`; pravidlo prohry dokáže robot,
 * který do něj schválně vleze.
 *
 * Co by vypadalo dobře a bylo špatně: odpověď s `lives: 5` projde schématem,
 * ale hra má dál tři životy; „guards patrol the halls“ dá stráže, které honí
 * hráče od prvního tiku jako dřív; „touch lava = lose“ kritik odmítne, protože
 * vítězný robot do lávy nikdy nevleze. Proto se tu měří až postavený svět:
 * mechanika životů, parametry pronásledování v ovládání jádra, nečinný hráč
 * v obou světech a důkaz slovesa z ověření.
 */

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, BODY_STRIDE, COUNTER, GRACE_MASK, GRACE_SHIFT, HEADER, HEADER_SIZE, HIT_GRACE, NO_INPUT, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, replay, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { avoidingLosses } from '@/play/arcade/rules/bot';
import { runBot, verifyArcade } from '@/play/arcade/verify';
import { applyRemix, remixPatch } from '@/play/director/remix';
import { type GenreModule, type GenreSpec, legacyCast, withCounts } from '@/play/genre/contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '@/play/genre/index';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

const guards = { genre: 'quest', mode: 'spatial', hero: 'thief', enemy: 'guard', target: { label: 'vault', verb: 'open', states: 2 }, setting: 'museum halls' } as const;
const runner = { genre: 'runner', mode: 'default', hero: 'fox', enemy: 'rock', setting: 'forest trail' } as const;

function game(input: unknown): GameSpecV1 {
  const read = readGenreSpec(input);
  if (!read.ok) throw new Error(read.issues.join('; '));
  const spec = readGameSpec(compileGenre(read.value));
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  return spec.value;
}

/** Svět prvního semínka, které robot vyhraje (jako dveře publikace, které zkusí další). */
function world(spec: GameSpecV1): ArcadeWorld {
  const issues: string[] = [];
  for (let seed = 1; seed <= 6; seed += 1) {
    const built = compileArcade(spec, seed);
    if (built.ok) return built.value.arcade as ArcadeWorld;
    issues.push(...built.issues);
  }
  throw new Error(issues.join('; '));
}

/** Parametry pronásledování z ovládání jádra (i pod obalem doplňků). */
function chaseOf(arcade: ArcadeWorld): { readonly patrol?: number } | undefined {
  const params = arcade.control.params as { readonly chase?: { readonly patrol?: number }; readonly base?: { readonly params: { readonly chase?: { readonly patrol?: number } } } };
  return params.chase ?? params.base?.params.chase;
}

describe('depth fields in the director answer (P36A T8)', () => {
  it('lives 5 with patrolling guards builds five lives and guards that patrol', () => {
    const spec = game({ ...guards, params: { lives: 5 }, enemyMoves: 'patrol' });
    expect(spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params).toEqual({ max: 5 });
    expect(chaseOf(world(spec))?.patrol).toBeGreaterThan(0);
  });

  it('a patrolling guard leaves an idle player alone longer than a chasing one, and the idle player still loses', () => {
    const chasing = world(game({ ...guards, enemyMoves: 'chase' }));
    const patrolling = world(game({ ...guards, enemyMoves: 'patrol' }));
    expect(chaseOf(chasing)?.patrol).toBeUndefined();
    const idleChased = replay(chasing, [], ARCADE_LIBRARY);
    const idlePatrolled = replay(patrolling, [], ARCADE_LIBRARY);
    expect(idleChased.outcome).toBe('lost');
    expect(idlePatrolled.outcome).toBe('lost');
    expect(idlePatrolled.tick).toBeGreaterThan(idleChased.tick);
  });

  // P39 T7: stojící nepřítel je v obsazení věc, které se hráč vyhýbá – ve hře zůstane vidět jako lovec.
  // Úkol bez lovce na startu říká `chasers: 0` (later rounds still bring pressure, T4).
  it('a still enemy in a quest stays a visible hunter; zero chasers means no hunter at the start', () => {
    expect(game({ ...guards, params: { chasers: 2 }, enemyMoves: 'still' }).roles).toContainEqual(expect.objectContaining({ kind: 'chaser', label: 'guard' }));
    const spec = game({ ...guards, params: { chasers: 0 }, enemyMoves: 'still' });
    expect(spec.roles.some((role) => role.kind === 'chaser')).toBe(false);
    expect((spec.controlParams as { readonly tuning: { readonly chasers: number } }).tuning.chasers).toBe(0);
    world(spec);
  });

  it('chase and shoot give the runner a chaser or a blaster, and the robot still wins', () => {
    const chased = game({ ...runner, enemyMoves: 'chase' });
    const shooting = game({ ...runner, enemyMoves: 'shoot' });
    expect(chased.addons).toEqual(['chaser']);
    expect(shooting.addons).toEqual(['shoot']);
    world(chased);
    world(shooting);
  });

  // P39 T7: každá role obsazení dostane svůj doplněk, ne jen první.
  it('a runner with a thing that chases and a thing to shoot gets both, and the robot still wins', () => {
    const both = game({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest trail', cast: [{ label: 'wolf', does: 'chase_me' }, { label: 'bat', does: 'shoot_at' }] });
    expect(both.addons).toEqual(['chaser', 'shoot']);
    expect(both.tutorial.controlsHint).toMatch(/Fire to shoot/);
    world(both);
  });

  it('target score and time limit reach the scoring and a losing clock', () => {
    const spec = game({ ...runner, params: { targetScore: 120, timeLimit: 85 } });
    expect(spec.scoring?.target).toBe(120);
    expect(spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params).toEqual({ id: 'clock', seconds: 85, onEnd: 'lose' });
    const built = arcadeWorldOf(spec, 1);
    expect(built.ok && built.world.rules.find((rule) => rule.id === 'time_limit')?.params).toEqual({ seconds: 85 });
  });

  it('a time limit on a quest replaces its clock; zero means none', () => {
    expect(game({ ...guards, params: { timeLimit: 70 } }).mechanics.find((mechanic) => mechanic.id === 'timer')?.params).toMatchObject({ seconds: 70, onEnd: 'lose' });
    const plain = game({ ...runner, params: { targetScore: 0, timeLimit: 0 } });
    expect(plain.scoring?.target).toBeUndefined();
    expect(plain.mechanics.some((mechanic) => mechanic.id === 'timer')).toBe(false);
  });

  it('an answer without the new fields builds the same game as before', () => {
    // Odpovědi starého tvaru jdou přes převod na obsazení jako ve `readGenreSpec` (P39).
    const answers = [
      runner,
      { genre: 'platformer', mode: 'default', hero: 'frog', setting: 'swamp' },
      { genre: 'arena', mode: 'escape', hero: 'mouse', cast: [{ label: 'cat', does: 'chase_me' }], setting: 'kitchen', params: { chasers: 2 } },
      { genre: 'voyage', mode: 'race', hero: 'sailboat', setting: 'bay' },
      guards,
    ].map((answer) => legacyCast(answer) as GenreSpec);
    for (const answer of answers) expect(compileGenre(answer)).toEqual((GENRE_MODULES[answer.genre] as GenreModule).compile(withCounts(answer) as never));
  });

  it('every remix chip keeps the lives, the target score, the clock and the enemy behaviour', () => {
    const parent = game({ ...runner, enemyMoves: 'shoot', params: { lives: 5, targetScore: 120, timeLimit: 85 } });
    for (const chip of ['harder', 'twist', 'swap_enemy', 'reskin'] as const) {
      const child = applyRemix(parent, remixPatch(chip, parent));
      if (!child.ok) throw new Error(`${chip}: ${child.detail}`);
      expect(child.spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params, chip).toEqual({ max: 5 });
      expect(child.spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params, chip).toMatchObject({ seconds: 85, onEnd: 'lose' });
      expect(child.spec.scoring?.target, chip).toBe(120);
      expect(child.spec.addons, chip).toEqual(['shoot']);
    }
  });

  it('bounds hold: lives 1–9, time limit up to 90 s, a known enemy behaviour', () => {
    expect(readGenreSpec({ ...runner, params: { lives: 9, timeLimit: 90, targetScore: 9999 } }).ok).toBe(true);
    expect(readGenreSpec({ ...runner, params: { lives: 0 } }).ok).toBe(false);
    expect(readGenreSpec({ ...runner, params: { lives: 10 } }).ok).toBe(false);
    expect(readGenreSpec({ ...runner, params: { timeLimit: 91 } }).ok).toBe(false);
    expect(readGenreSpec({ ...runner, enemyMoves: 'fly' }).ok).toBe(false);
  });
});

describe('a lose rule is proved by a robot that walks into it (P36A T8)', () => {
  const lava = {
    genre: 'arena',
    mode: 'collect',
    hero: 'explorer',
    collectible: 'gem',
    setting: 'volcano cave',
    ruleRoles: [{ id: 'lava', kind: 'hazard', label: 'lava pool' }],
    rules: [{ id: 'burn', verb: 'touch', when: { contact: ['player', 'lava'] }, do: [{ lose: true }] }],
  };

  it('"touch lava" passes the check: the winning robot avoids it, the losing one fires it', () => {
    const verdict = verifyArcade(world(game(lava)));
    expect(verdict.failures).toEqual([]);
    expect(verdict.verbs).toEqual([expect.objectContaining({ verb: 'touch', fired: true, changed: true })]);
    expect(verdict.bot.outcome).toBe('won');
  });

  it('a lose rule on a body nobody can reach stays unproved', () => {
    const hidden = { ...lava, things: [{ role: 'lava', start: 'hidden' }] };
    const verdict = verifyArcade(world(game(hidden)));
    expect(verdict.failures.some((failure) => failure.includes('VERB_UNPROVED:touch'))).toBe(true);
  });

  // F2 (z T8): robot arény lávu neznal a vlezl do ní na semínku 1 i 3 – hra s pravidlem prohry prošla jen náhodou.
  it('the winning robot steps around the lava on seeds 1–3, the losing robot still walks in', () => {
    const spec = game(lava);
    for (let seed = 1; seed <= 3; seed += 1) {
      const built = arcadeWorldOf(spec, seed);
      if (!built.ok) throw new Error(built.issues.join('; '));
      expect(runBot(built.world).outcome, `seed ${String(seed)}`).toBe('won');
      expect(runBot(built.world, ARCADE_LIBRARY, { seek: new Set(['touch']) }).outcome, `seed ${String(seed)} seek`).toBe('lost');
    }
  });

  // Semínka, kde láva leží v cestě: bez obcházení robot úkolu na nich do lávy vleze (naměřeno 2. 10. 2026).
  it('a quest robot steps around lava too', () => {
    const spec = game({ ...guards, ruleRoles: lava.ruleRoles, rules: lava.rules });
    for (const seed of [6, 8, 10]) {
      const built = arcadeWorldOf(spec, seed);
      if (!built.ok) throw new Error(built.issues.join('; '));
      expect(runBot(built.world).outcome, `seed ${String(seed)}`).toBe('won');
    }
  });

  // Láva, která ubírá život, ale i dává skóre: tu robot potřebuje, takže ji neobchází – obal vrátí robota beze změny.
  it('a role that a non-losing rule needs is not avoided', () => {
    const decide = () => NO_INPUT;
    const both = (rules: unknown[]): ArcadeWorld => {
      const built = arcadeWorldOf(game({ ...lava, rules }), 1);
      if (!built.ok) throw new Error(built.issues.join('; '));
      return built.world;
    };
    const burn = { id: 'burn', verb: 'touch', when: { contact: ['player', 'lava'] }, do: [{ damage: 1 }] };
    const warm = { id: 'warm', verb: 'warm', when: { contact: ['player', 'lava'] }, do: [{ score: 1 }] };
    expect(avoidingLosses(both([burn]), decide)).not.toBe(decide);
    expect(avoidingLosses(both([burn, warm]), decide)).toBe(decide);
  });

  // Obcházení platí jen pro volný pohyb (aréna, úkol); běžec v pruzích dostane robota tak, jak je.
  it('a world without free movement keeps its bare robot even with a lose rule', () => {
    const decide = () => NO_INPUT;
    const built = arcadeWorldOf(game({ ...runner, ruleRoles: lava.ruleRoles, rules: lava.rules }), 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(built.world.control.id).not.toBe('move_free');
    expect(avoidingLosses(built.world, decide)).toBe(decide);
  });

  // F1 (z T8): `damage` z pravidla specu dřív bral život každý tik – tři životy padly za tři tiky v lávě.
  it('a damage rule takes one life per hit: 30 ticks in lava cost exactly one life', () => {
    const arcade = world(game({ ...lava, rules: [{ id: 'burn', verb: 'touch', when: { contact: ['player', 'lava'] }, do: [{ damage: 1 }] }] }));
    const lavaRole = (arcade.rules.find((ref) => ref.id === 'rule_contact')!.params as { when: { contact: readonly [number, number] } }).when.contact[1];
    const state = instantiate(arcade);
    const bodies = (state.length - HEADER_SIZE) / BODY_STRIDE;
    const pool = Array.from({ length: bodies }, (_, i) => i).find((i) => state[bodyBase(i) + BODY.role] === lavaRole)!;
    const player = bodyBase(state[HEADER.player] as number);
    state[player + BODY.x] = state[bodyBase(pool) + BODY.x] as number;
    state[player + BODY.z] = state[bodyBase(pool) + BODY.z] as number;
    const lives = state[HEADER.counters + COUNTER.health] as number;
    expect(lives).toBe(3);
    const program = loadProgram(arcade, ARCADE_LIBRARY);
    // Tiky, ve kterých padl život; milost chrání i poslední.
    const lost: number[] = [];
    for (let tick = 0, left = lives; tick < 4 * HIT_GRACE && left > 0; tick += 1) {
      step(state, NO_INPUT, program);
      if (tick === 29) expect(state[HEADER.counters + COUNTER.health], '30 ticks in lava').toBe(lives - 1);
      if ((state[HEADER.counters + COUNTER.health] as number) < left) (lost.push(tick), (left = state[HEADER.counters + COUNTER.health] as number));
    }
    expect(lost).toHaveLength(lives);
    for (let i = 1; i < lost.length; i += 1) expect(lost[i]! - lost[i - 1]!, `life ${String(i + 1)}`).toBeGreaterThanOrEqual(HIT_GRACE);
  });

  it('a damage rule in a game without lives sets no grace, so the old state does not move', () => {
    const arcade = world(game({ ...lava, rules: [{ id: 'burn', verb: 'touch', when: { contact: ['player', 'lava'] }, do: [{ damage: 1 }] }] }));
    const noLives = { ...arcade, initial: arcade.initial.map((value, i) => (i === HEADER.counters + COUNTER.health ? 0 : value)) };
    const lavaRole = (arcade.rules.find((ref) => ref.id === 'rule_contact')!.params as { when: { contact: readonly [number, number] } }).when.contact[1];
    const state = instantiate(noLives);
    const pool = Array.from({ length: (state.length - HEADER_SIZE) / BODY_STRIDE }, (_, i) => i).find((i) => state[bodyBase(i) + BODY.role] === lavaRole)!;
    const player = bodyBase(state[HEADER.player] as number);
    state[player + BODY.x] = state[bodyBase(pool) + BODY.x] as number;
    state[player + BODY.z] = state[bodyBase(pool) + BODY.z] as number;
    step(state, NO_INPUT, loadProgram(noLives, ARCADE_LIBRARY));
    expect(state[HEADER.counters + COUNTER.health]).toBe(-1);
    expect(((state[player + BODY.flags] as number) >> GRACE_SHIFT) & GRACE_MASK).toBe(0);
  });
});
