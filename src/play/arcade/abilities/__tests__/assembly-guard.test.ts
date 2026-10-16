/**
 * Dash a štít proti dílům složené hry (P47B T4). Padající díl („falling acorns“)
 * hrdinovi ublíží vlastní větví `assembly_part`, ne nárazem `hit`: v aktivním
 * dashi ho hrdina prorazí (díl zmizí a nic nevezme), nabitý štít ho odrazí blokem
 * a spotřebuje svůj náboj, bez stisku díl zraní jako dřív. Věta s dílem si akci
 * nechá – robot intermediate ji na díl zmáčkne a ověření sloveso dokáže. Hra bez
 * akcí staví týž svět jako před T4.
 *
 * Řízení jen mechanikou: kámen se pustí 6,5 m před autem a padá 120 j/tik, auto
 * (~300 j/tik) je pod ním za ~22 tiků a projede 4,5 m pod ním (změřeno na semínkách
 * 1–4). Robot ho tak nikdy nedostihne a věta o řízení akci dál ztratí (`VERB_UNPROVED`).
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../../draft';
import { type GameSpecV1, readGameSpec } from '../../../spec';
import { arcadeWorldOf, preloadPhysics } from '../../compile';
import {
  ABILITY_SLOTS,
  type AbilityId,
  type ArcadeEffect,
  type ArcadeWorld,
  BODY,
  BUTTON,
  COUNTER,
  FLAG,
  HEADER,
  type InputEvent,
  NO_INPUT,
  bodyBase,
  mapUnderlying,
  underlyingRule,
} from '../../contract';
import { instantiate, loadProgram, outcomeOf, replay, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';
import runner from '../../__fixtures__/runner.json';
import platform from '../../__fixtures__/platform.json';
import steer from '../../__fixtures__/steer.json';

const FIXTURES = { runner, platform, steer } as const;
type Control = keyof typeof FIXTURES;
const CONTROLS = Object.keys(FIXTURES) as Control[];
const SEEDS = [1, 2, 3, 4];

/** Spec fixtury s padajícími kameny – díly složené hry (`assemblyParts`), každý se svou rolí. */
function rockSpec(control: Control, abilities: readonly AbilityId[], rocks = ['rock']): GameSpecV1 {
  const fixture = FIXTURES[control];
  const read = readGameSpec({
    ...fixture,
    roles: [...fixture.roles, ...rocks.map((id) => ({ id, kind: 'hazard', label: 'falling rock' }))],
    assemblyParts: rocks.map((role) => ({ kind: 'hazard', role, motion: 'fall' })),
    ...(abilities.length === 0 ? {} : { abilities }),
  });
  if (!read.ok) throw new Error(`${control}: ${read.issues.join('; ')}`);
  return read.value;
}

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Těla dílů složené hry, které zraní (nebezpečí). */
const partsOf = (world: ArcadeWorld): number[] =>
  world.rules
    .map(underlyingRule)
    .filter((rule) => rule.id === 'assembly_part' && (rule.params.part as { kind: string }).kind === 'hazard')
    .map((rule) => (rule.params.part as { body: number }).body);

interface Traced {
  readonly tick: number;
  /** Index pravidla světa a id jeho jádra. */
  readonly index: number;
  readonly rule: string;
  readonly effect: ArcadeEffect;
}

const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/**
 * Přehraje vstupy `inputs` (do konce hry nebo tiku `until`) se stopou: efekty, které stav změnily, s pravidlem.
 * `before` smí stav před tikem upravit.
 */
function traced(world: ArcadeWorld, inputs: (tick: number) => InputEvent | undefined, until: number, before?: (state: Int32Array, tick: number) => void): { state: Int32Array; effects: Traced[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const ids = world.rules.map((rule) => underlyingRule(rule).id);
  const effects: Traced[] = [];
  for (let tick = 0; tick < until && outcomeOf(state) === 'running'; tick += 1) {
    before?.(state, tick);
    step(state, inputs(tick) ?? NO_INPUT, program, (rule, effect) => effects.push({ tick, index: rule, rule: ids[rule] as string, effect }));
  }
  return { state, effects };
}

/** Řídké vstupy běhu robota jako funkce tiku. */
function recorded(inputs: readonly InputEvent[]): (tick: number) => InputEvent | undefined {
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  return (tick) => byTick.get(tick);
}

const hitsPart = (parts: readonly number[], rule: string) => (traced: Traced): boolean =>
  traced.rule === rule && traced.effect.kind === 'despawn' && parts.includes(traced.effect.body);

/** Týž svět, jen díly bez ochrany: pravidlo dílu bez `guard`, dash a štít bez těl dílů. */
const unguarded = (world: ArcadeWorld): ArcadeWorld => ({
  ...world,
  rules: world.rules.map((ref) =>
    mapUnderlying(ref, (native) => {
      const { guard: _guard, parts, ...rest } = native.params;
      if (native.id === 'assembly_part') return { ...native, params: { ...rest, parts } };
      return native.id === 'ability_dash' || native.id === 'ability_shield' ? { ...native, params: rest } : native;
    }),
  ),
});

beforeAll(async () => {
  await loadRapier();
  for (const control of CONTROLS) await preloadPhysics(rockSpec(control, []), loadRapier);
});

// Věty psané pro tenhle test, ne ze sad měření.
const SENTENCES = [
  ['runner', 'dash', 'a squirrel runs and dodges falling acorns'],
  ['runner', 'shield', 'a squirrel runs and blocks falling acorns'],
  ['platform', 'dash', 'a frog jumps and dashes through falling coconuts'],
  ['platform', 'shield', 'a frog jumps and blocks falling coconuts'],
] as const;

describe('P47B T4: a sentence with falling parts keeps its action', () => {
  it.each(SENTENCES)('%s %s ("%s"): the intermediate bot guards a part and the verb is proved', (control, ability, text) => {
    const { spec } = draftGameSpecWithMeta(text, 1);
    expect(spec.control).toBe(control);
    expect(spec.abilities).toEqual([ability]);
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const parts = partsOf(world);
      expect(parts.length, `seed ${seed}: no falling part`).toBeGreaterThan(0);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      const played = traced(world, recorded(run.inputs), run.tick + 1).effects;
      const guarded = played.filter(hitsPart(parts, `ability_${ability}`));
      expect(guarded.length, `seed ${seed}: the ${ability} never took a part`).toBeGreaterThan(0);
      // Díl, který akce vzala, v tom tiku nic nevzal (druhý díl téhož tiku smí – štít má jeden náboj, R2).
      const taken = new Set(guarded.map(({ tick, effect }) => `${String(tick)}:${String((effect as { body: number }).body)}`));
      const owners = world.rules.map((rule) => (underlyingRule(rule).params.part as { body?: number } | undefined)?.body);
      const hurtBy = played.filter(({ index, effect }) => effect.kind === 'damage' && owners[index] !== undefined).map(({ tick, index }) => `${String(tick)}:${String(owners[index])}`);
      expect(hurtBy.filter((key) => taken.has(key)), `seed ${seed}`).toEqual([]);
      // Tytéž vstupy v téže hře, jen díly bez ochrany: díl, který akce vzala, hrdinu v tom tiku zraní.
      // Vstupy bez tlačítka akce nestačí – skákačka po zásahu hrotu vrátí hrdinu na checkpoint a k dílu nedojde.
      const [{ tick: at }] = guarded as [Traced];
      const hurt = traced(unguarded(world), recorded(run.inputs), at + 1).effects;
      expect(hurt.some(({ tick, rule, effect }) => tick === at && rule === 'assembly_part' && effect.kind === 'damage'), `seed ${seed}: the part would not hurt`).toBe(true);
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === ability)?.changed, `seed ${seed}`).toBe(true);
    }
  }, 300_000);
});

/** Tik, kdy test vrazí kameny do hrdiny; akce jde o 2 tiky dřív. */
const RAM_AT = 40;

/** Přehraje svět do `RAM_AT + 4`; v tiku `RAM_AT` postaví kameny `bodies` na hrdinu, akci zmáčkne (`press`) o 2 tiky dřív. */
function ram(world: ArcadeWorld, bodies: readonly number[], press: boolean): { state: Int32Array; effects: Traced[]; start: number } {
  const start = health(instantiate(world));
  const { state, effects } = traced(
    world,
    (tick) => (press && tick === RAM_AT - 2 ? { tick, buttons: BUTTON.ACTION_A, axis: 0 } : undefined),
    RAM_AT + 4,
    (now, tick) => {
      if (tick === RAM_AT) expect(health(now), 'hurt before the ram').toBe(start);
      if (tick !== RAM_AT) return;
      const p = bodyBase(now[HEADER.player] as number);
      for (const body of bodies) for (const axis of [BODY.x, BODY.y, BODY.z]) now[bodyBase(body) + axis] = now[p + axis] as number;
    },
  );
  return { state, effects, start };
}

describe.each(CONTROLS)('P47B T4: guard mechanics against a falling part on %s', (control) => {
  it('without abilities the part hurts as before', () => {
    const world = worldOf(rockSpec(control, []), 1);
    const { state, effects, start } = ram(world, partsOf(world), false);
    expect(health(state)).toBe(start - 1);
    expect(effects.some(({ rule, effect }) => rule === 'assembly_part' && effect.kind === 'damage')).toBe(true);
  });

  it('a dash breaks through the part: it vanishes and takes nothing; without the press it hurts', () => {
    const world = worldOf(rockSpec(control, ['dash']), 1);
    const parts = partsOf(world);
    const dashed = ram(world, parts, true);
    expect(health(dashed.state)).toBe(dashed.start);
    expect(alive(dashed.state, parts[0] as number)).toBe(false);
    expect(dashed.effects.some(hitsPart(parts, 'ability_dash'))).toBe(true);
    const idle = ram(world, parts, false);
    expect(health(idle.state)).toBe(idle.start - 1);
  });

  it('a charged shield blocks the part with its one charge; without the press it hurts', () => {
    const world = worldOf(rockSpec(control, ['shield']), 1);
    const parts = partsOf(world);
    const keeper = (underlyingRule(world.rules.find((rule) => underlyingRule(rule).id === 'ability_shield')!).params as { keeper: number }).keeper;
    const shielded = ram(world, parts, true);
    expect(health(shielded.state)).toBe(shielded.start);
    expect(alive(shielded.state, parts[0] as number)).toBe(false);
    expect(shielded.effects.some(hitsPart(parts, 'ability_shield'))).toBe(true);
    expect(shielded.state[bodyBase(keeper) + ABILITY_SLOTS.shield]).toBe(0);
    const idle = ram(world, parts, false);
    expect(health(idle.state)).toBe(idle.start - 1);
  });

  it('one shield charge blocks only one of two parts landing in the same tick (R2)', () => {
    const world = worldOf(rockSpec(control, ['shield'], ['rock', 'pebble']), 1);
    const parts = partsOf(world);
    expect(parts).toHaveLength(2);
    const { state, effects, start } = ram(world, parts, true);
    expect(effects.filter(hitsPart(parts, 'ability_shield'))).toHaveLength(1);
    expect(health(state)).toBe(start - 1);
  });
});

/** Otisk světa: `JSON.stringify` přes SHA-256, prvních 16 znaků. */
const fingerprint = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

// [ovládání, otisk světa, tik robota, hash robota, hash nečinného hráče] – semínko 1, změřeno se `assembly-parts.ts` před T4 (10e4105f).
const BEFORE = [
  ['runner', 'd701ffb1537311a5', 1522, '6601c2a2', '59f40cb0'],
  ['platform', 'e7f7eee8b556d3b1', 125, '6829d72d', '751436bc'],
  ['steer', '083084ef223207e7', 1406, '31a80f9f', '44d852f6'],
] as const;

describe('P47B T4: a game with parts and without abilities builds the world it had before', () => {
  it.each(BEFORE)('%s', (control, world, tick, won, idle) => {
    const built = worldOf(rockSpec(control, []), 1);
    expect(fingerprint(built)).toBe(world);
    // Ochrana dílů jen ve hře s akcemi: žádný `guard` ani těla dílů (`parts`) v pravidlech a robotovi.
    expect(JSON.stringify([built.rules, built.bot])).not.toMatch(/"guard"|"parts":\[\d/);
    const run = runBot(built);
    expect([run.tick, run.hash]).toEqual([tick, won]);
    expect(replay(built, [], ARCADE_LIBRARY).hash).toBe(idle);
  });

  it('with an ability the part rule, the guard rules and the bot know the part', () => {
    const built = worldOf(rockSpec('runner', ['dash']), 1);
    const [body] = partsOf(built);
    const part = built.rules.map(underlyingRule).find((rule) => rule.id === 'assembly_part');
    expect(part?.params.guard).toMatchObject({ dash: 0 });
    expect(built.rules.map(underlyingRule).find((rule) => rule.id === 'ability_dash')?.params.parts).toEqual([body]);
    expect(JSON.stringify(built.bot)).toContain(`"parts":[${String(body)}]`);
  });
});
