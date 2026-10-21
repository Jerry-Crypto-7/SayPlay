/**
 * Duel, ve kterém hrdina střílí nebo krade (P52 T8). Duel bral jen úder, dash a štít, takže věty „duels the sheriff,
 * firing a ray gun“ a „duels another thief to swipe the king's crown“ akci ztratily (P47B v54, v67, dev P52 d23, d24,
 * d26). Přesměrování na střílečku by vzalo duelu jeho přestřelku za poledne („cowboy duel at high noon, first to shoot
 * wins“ je duel od P36A), proto duel zůstane duelem a střelba nebo krádež je sloveso zásahu soupeře jako úder (P47B T8):
 * Tap, žádné druhé tlačítko, nápověda říká sloveso věty. Ostatní duelové věty zůstanou duelem.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import p47a from '../../../evals/play/p47a/dev.json';
import { genreOfSpec } from '../../../evals/play/p47a/finale';
import { verbRow } from '../../../evals/play/p47b/actions';
import { underlyingRule } from '../arcade/contract';
import { arcadeWorldOf } from '../arcade/compile';
import { loadRapier } from '../arcade/physics/world';
import { draftGameSpecWithMeta } from '../draft';
import type { AbilityId } from '../spec';

beforeAll(async () => {
  await loadRapier();
});

/** Věty mezery, akce hrdiny a sloveso, které řekne nápověda. */
const DUELS: readonly (readonly [string, string, AbilityId, string])[] = [
  ['d23', 'a cowboy duels a bandit and fires his revolver at high noon', 'shoot', 'fire'],
  ['d24', 'Two mages duel on a cliff and shoot lightning at each other.', 'shoot', 'shoot'],
  ['v54', 'an alien gunslinger duels the sheriff, firing a ray gun at noon', 'shoot', 'fire'],
  ['d26', 'A street kid duels a rival to snatch the last golden ticket.', 'grab', 'snatch'],
  ['v67', "a pickpocket duels another thief to swipe the king's crown", 'grab', 'swipe'],
];

/**
 * Duely bez střelby a krádeže: P47B T8 a P36A (duel), P47A dev (buňka duel), P47B dev v02, v07 (úder). Věta v07
 * („shoves rivals out of a shrinking ring“) hraje od P54C T13b vytlačování z ringu – tady stojí duel se stejnými díly.
 */
const KEPT: readonly (readonly [string, string])[] = [
  ['p36a', 'cowboy duel at high noon, first to shoot wins'],
  ...p47a.sentences.filter((sentence) => sentence.cell === 'duel').map((sentence) => [sentence.id, sentence.text] as const),
  ['v02', 'A kangaroo boxer punches a robot opponent in a neon ring.'],
  ['v07', 'a sumo wrestler shoves rivals around a shrinking ring'],
];

describe('P52 T8: a duel the hero shoots or grabs in keeps the duel and plays the action on its hit', () => {
  it.each(DUELS)('%s: the duel takes the action, the bot uses it and the verb fires', async (id, text, wants) => {
    const row = await verbRow({ id, text, wants: [wants] });
    expect(row.genre).toBe('duel');
    expect(row.present).toContain(wants);
    expect([row.hasAction, row.botUsed, row.verbFired, row.playable]).toEqual([true, true, true, true]);
  });

  it.each(DUELS)('%s: the rival hit carries the verb and the hint says the sentence word', (_id, text, wants, word) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.abilities).toEqual([wants]);
    expect(spec.tutorial.controlsHint).toContain(`to ${word}`);
    expect(spec.tutorial.controlsHint).not.toContain('to strike');
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(made.world.rules.map(underlyingRule).filter((rule) => rule.id === 'judge').map((rule) => rule.params.verb)).toEqual([wants]);
  });

  // Zásah nese jedno sloveso: druhý zásah by ve hře nic nedělal, úder má přednost; úhyb jde vedle zásahu.
  it.each([
    ['a fox duels a bear, steals its eggs and punches it', ['strike'], 'strike', []],
    ['a pickpocket duels a thief to snatch the crown and dodges his knife', ['grab', 'dash'], 'grab', ['dash']],
  ] as const)('"%s": one hit verb on the rival, the dodge beside it', (text, abilities, hit, dodges) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.control).toBe('duel');
    expect(spec.abilities).toEqual(abilities);
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const rules = made.world.rules.map(underlyingRule);
    expect(rules.filter((rule) => rule.id === 'judge').map((rule) => rule.params.verb)).toEqual([hit]);
    expect(rules.filter((rule) => rule.id === 'duel_dodge').map((rule) => rule.params.verb)).toEqual(dodges);
  });

  // Svět duelu bez akce drží otisk v `duel-verbs.test.ts` (P47B T8).
  it.each(KEPT)('%s: the other duel sentences stay duels', (_id, text) => {
    expect(genreOfSpec(draftGameSpecWithMeta(text, 1).spec)).toBe('duel');
  });
});
