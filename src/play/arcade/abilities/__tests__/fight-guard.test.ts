/**
 * Dash a štít v souboji v aréně (P47B T6). Úder soupeře v souboji nese ovládání
 * (`fight`), ne náraz `hit`: úder, který by hrdinu zasáhl, nabitý štít odrazí a spotřebuje
 * svůj náboj, dash v okně ho propustí, bez stisku zasáhne jako dřív. Pravidlo
 * `ability_fight_guard` za odražený úder dá bod a nese sloveso. Robot souboje akci zmáčkne
 * před úderem a zůstane stát, ať ji úder potká. Souboj bez akcí staví týž svět jako před T6.
 *
 * Štít bez náboje (odrazí každý úder) pozná jen kontrola náboje: novice souboj prohrává na čas,
 * ne na údery, a i s nesmrtelným štítem vyhraje nejvýš 0,7 (brána `abilities-difficulty`).
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../../draft';
import { type GameSpecV1, readGameSpec } from '../../../spec';
import { arcadeWorldOf } from '../../compile';
import {
  ABILITY_SLOTS,
  type AbilityId,
  type ArcadeEffect,
  type ArcadeWorld,
  BUTTON,
  HEADER,
  type InputEvent,
  NO_INPUT,
  type PieceRef,
  bodyBase,
  underlyingRule,
} from '../../contract';
import { instantiate, loadProgram, outcomeOf, replay, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';

const SEEDS = [1, 2, 3, 4];

beforeAll(async () => {
  await loadRapier();
});

// Věty psané pro tenhle test, ne ze sad měření.
const SENTENCES = ['a mouse defends its cheese from a hungry cat', 'a hero blocks punches from a giant'] as const;

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Spec věty s akcemi `abilities` místo těch, které dal návrh (prázdné = bez akcí). */
function withAbilities(spec: GameSpecV1, abilities: readonly AbilityId[]): GameSpecV1 {
  // Slova tlačítek (P47B T10) patří zahozeným akcím věty – jdou s nimi.
  const { abilities: _abilities, abilityWords: _words, ...plain } = spec;
  const read = readGameSpec({ ...plain, ...(abilities.length === 0 ? {} : { abilities }) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

interface Traced {
  readonly tick: number;
  readonly rule: string;
  readonly effect: ArcadeEffect;
}

/** Přehraje řídké vstupy do konce hry nebo tiku `until` se stopou efektů, které stav změnily. */
function traced(world: ArcadeWorld, inputs: readonly InputEvent[], until: number): { state: Int32Array; effects: Traced[] } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const ids = world.rules.map((rule) => underlyingRule(rule).id);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  const effects: Traced[] = [];
  for (let tick = 0; tick < until && outcomeOf(state) === 'running'; tick += 1) {
    step(state, byTick.get(tick) ?? NO_INPUT, program, (rule, effect) => effects.push({ tick, rule: ids[rule] as string, effect }));
  }
  return { state, effects };
}

/** Ovládání bez ochrany souboje: `guard` pryč ze základního ovládání pod obaly. */
const bare = (control: PieceRef): PieceRef => {
  const { base, guard: _guard, ...rest } = control.params;
  return base === undefined ? { ...control, params: rest } : { ...control, params: { ...control.params, base: bare(base as PieceRef) } };
};

const keeperOf = (world: ArcadeWorld): number => (underlyingRule(world.rules.find((rule) => underlyingRule(rule).id === 'ability_fight_guard')!).params as { keeper: number }).keeper;

/** Odražený úder: bod pravidla slovesa souboje (ve hře jen se štítem je to štít). */
const blockedBlow = (traced: Traced): boolean => traced.rule === 'ability_fight_guard' && traced.effect.kind === 'score';

describe('P47B T6: a sentence about an arena fight keeps its shield', () => {
  it.each(SENTENCES)('"%s": the intermediate bot blocks a blow, the blow would hurt, the verb is proved', (text) => {
    const { spec } = draftGameSpecWithMeta(text, 1);
    expect(spec.control).toBe('move_free');
    expect((spec.controlParams as { generator?: string }).generator).toBe('fight');
    expect(spec.abilities).toEqual(['shield']);
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      const played = traced(world, run.inputs, run.tick + 1);
      const blocked = played.effects.filter(blockedBlow);
      expect(blocked.length, `seed ${seed}: the shield never took a blow`).toBeGreaterThan(0);
      const player = played.state[HEADER.player] as number;
      const [{ tick: at }] = blocked as [Traced];
      expect(played.effects.some(({ tick, effect }) => tick === at && effect.kind === 'hit' && effect.body === player), `seed ${seed}: hit while blocked`).toBe(false);
      // Týž nářez bez ochrany souboje: úder, který štít vzal, hrdinu v tom tiku zasáhne.
      const hurt = traced({ ...world, control: bare(world.control) }, run.inputs, at + 1).effects;
      expect(hurt.some(({ tick, effect }) => tick === at && effect.kind === 'hit' && effect.body === player), `seed ${seed}: the blow would not hurt`).toBe(true);
      // Jeden náboj: po odraženém úderu je štít prázdný.
      expect(traced(world, run.inputs, at + 1).state[bodyBase(keeperOf(world)) + ABILITY_SLOTS.shield], `seed ${seed}: charge kept`).toBe(0);
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === 'shield')?.changed, `seed ${seed}`).toBe(true);
    }
  }, 300_000);
});

describe('P47B T6: dash and the pair dash + shield in an arena fight', () => {
  it.each([[['dash']], [['shield', 'dash']]] as const)('%j: every verb is proved on 4 seeds', (abilities) => {
    const spec = withAbilities(draftGameSpecWithMeta(SENTENCES[0], 1).spec, abilities);
    for (const seed of SEEDS) {
      const verdict = verifyArcade(worldOf(spec, seed));
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      for (const verb of abilities) expect(verdict.verbs.find((proof) => proof.verb === verb)?.changed, `seed ${seed} ${verb}`).toBe(true);
    }
  }, 300_000);
});

/** Otisk světa: `JSON.stringify` přes SHA-256, prvních 16 znaků. */
const fingerprint = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

describe('P47B T6: an arena fight without abilities builds the world it had before', () => {
  // Semínko 1, změřeno nad 1c76cb71 (před T6): otisk světa, tik a hash robota, hash nečinného hráče.
  it.each(SENTENCES)('"%s"', (text) => {
    const built = worldOf(withAbilities(draftGameSpecWithMeta(text, 1).spec, []), 1);
    expect(fingerprint(built)).toBe('ef1c82ae5b2346d3');
    expect(JSON.stringify([built.control, built.rules])).not.toMatch(/"guard"|ability_fight_guard/);
    const run = runBot(built);
    expect([run.tick, run.hash]).toEqual([3322, 'c2d58dad']);
    expect(replay(built, [], ARCADE_LIBRARY).hash).toBe('cb032be4');
  });
});
