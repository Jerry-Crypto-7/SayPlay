/**
 * Duel dokazuje slovesa věty vlastní mechanikou (P47B T8). Úder (Tap) je akce úder,
 * úhyb (Down) dash i štít – druhé tlačítko duel nedostane. Zásah soupeře nese
 * `params.verb: 'strike'` na pravidle `judge`, úspěšný úhyb pravidlo `duel_dodge`
 * se slovesem dash nebo štít – jen ve hře, jejíž spec akci chce. Starý duel bez
 * akcí staví týž svět jako před T8.
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { type AbilityId, type ArcadeWorld, BUTTON, underlyingRule } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { abilitiesOf } from '@/components/play/arcade/ActionButton';
import { runBot, verifyArcade } from '../verify';

const SEEDS = [1, 2, 3, 4];
// Věta psaná pro tenhle test, ne ze sad měření.
const SUMO = 'a sumo bear shoves rivals out of the ring';

beforeAll(async () => {
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

function withAbilities(spec: GameSpecV1, abilities: readonly AbilityId[]): GameSpecV1 {
  // Slova tlačítek (P47B T10) patří zahozeným akcím věty – jdou s nimi.
  const { abilities: _abilities, abilityWords: _words, ...plain } = spec;
  const read = readGameSpec({ ...plain, ...(abilities.length === 0 ? {} : { abilities }) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

const fingerprint = (world: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

describe('P47B T8: a duel proves the sentence verbs with its own punch and dodge', () => {
  it('"a sumo bear shoves rivals out of the ring" gives a duel with strike; the bot punches and the verb is proved', () => {
    const { spec } = draftGameSpecWithMeta(SUMO, 1);
    expect(spec.control).toBe('duel');
    expect(spec.abilities).toEqual(['strike']);
    expect(spec.tutorial.controlsHint.length).toBeLessThanOrEqual(80);
    // Nápověda duelu říká sloveso věty (P47B T10: „shoves“ → shove); tlačítko J duel nemá.
    expect(spec.tutorial.controlsHint).toMatch(/to shove.*to dodge/);
    expect(spec.tutorial.controlsHint).not.toMatch(/\bJ to\b/);
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      // Žádné druhé tlačítko: akce hraje mechanika duelu.
      expect(abilitiesOf(world)).toEqual([]);
      expect(runBot(world).inputs.some((event) => (event.buttons & BUTTON.TAP) !== 0), `seed ${seed}`).toBe(true);
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === 'strike')?.changed, `seed ${seed}`).toBe(true);
    }
  }, 300_000);

  it.each([[['dash']], [['shield']], [['strike', 'shield']]] as const)('%j: the dodge (and punch) prove every verb on 4 seeds', (abilities) => {
    const spec = withAbilities(draftGameSpecWithMeta(SUMO, 1).spec, abilities);
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(world.rules.map(underlyingRule).filter((rule) => rule.id === 'duel_dodge').map((rule) => rule.params.verb)).toEqual(abilities.filter((id) => id !== 'strike'));
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      for (const verb of abilities) expect(verdict.verbs.find((proof) => proof.verb === verb)?.changed, `seed ${seed} ${verb}`).toBe(true);
    }
  }, 300_000);
});

describe('P47B T8: a duel without abilities builds the world it had before', () => {
  // Semínko 1, změřeno nad 550c289e (před T8; duel se od abe38f04 nezměnil): otisk světa, tik a hash robota, hash nečinného hráče.
  // Otisk světa a oba hashe po sloučení s P47A (šampion `genre.v4`) přeměřeny na samotné P47A – týž jako sloučená větev.
  it('the sumo duel without abilities', () => {
    // Otisk `genre.v4`: nová hra (`genre.v5`, P51 T6) má navíc hozenou věc soupeře – hlídá ji `p51-foes.test.ts`.
    const plain = withAbilities(draftGameSpecWithMeta(SUMO, 1).spec, []);
    const built = worldOf({ ...plain, genre: { ...plain.genre!, compilerVersion: 'genre.v4' } }, 1);
    expect(JSON.stringify([built.control, built.rules])).not.toMatch(/"verb"|"dodges"|duel_dodge/);
    const run = runBot(built);
    expect([fingerprint(built), run.tick, run.hash, replay(built, [], ARCADE_LIBRARY).hash]).toEqual(['389710414ae06416', 2469, '01605e5d', '61671e5c']);
  });
});
