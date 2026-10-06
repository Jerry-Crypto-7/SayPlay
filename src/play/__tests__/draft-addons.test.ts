/**
 * Druhé sloveso věty jako doplněk (P26D T8): „jump and shoot“ je plošinovka se
 * střelbou, ne střelnice. Pin nad korpusem poptávky
 * (`evals/play/demand/corpus.json`): věty s pohybem a druhým herním slovesem.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../arcade/compile';
import { verifyArcade } from '../arcade/verify';
// P32B T2: doplňky ovládání nese jen šablona remixu uložených legacy her – zkouší se přes ni.
import { legacyDraft } from './legacy-draft';
import { pickControl } from '../draft/controls';
import { draftGameSpecWithMeta } from '../draft';

interface DemandEntry {
  readonly id: string;
  readonly text: string;
}

const corpus = JSON.parse(readFileSync(new URL('../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as DemandEntry[];

// Nezávislé na `controls.ts`: pohyb hráče a vedle něj sloveso doplňku.
const MOVE = /\b(?:jump\w*|hop\w*|runs?|running|runner|platformer)\b/;
const SECOND = /\b(?:shoot(?:s|ing)?|collect\w*|grab\w*|gather\w*|chas(?:ed|ing)|hunted|lives)\b/;

describe('two verbs in the word draft', () => {
  it.each([
    ['jump and shoot the zombies', 'platform', ['shoot']],
    ['run and collect coins', 'runner', ['collect']],
    ['a runner collecting coins chased by a bear', 'runner', ['collect', 'chaser']],
    ['a platformer with three lives', 'platform', ['lives']],
    ['endles runner with zombies chasing u', 'runner', ['chaser']],
  ] as const)('%s → %s + %j', (sentence, control, addons) => {
    expect(pickControl(sentence)).toMatchObject({ control, addons });
  });

  it.each([
    ['an endless runner through a fashion photo shoot', 'runner'],
    ['a platformer where you jump over shooting stars', 'platform'],
    ['a platformer in a coin factory', 'platform'],
  ] as const)('%s gets no addon', (sentence, control) => {
    const choice = pickControl(sentence);
    expect(choice?.control).toBe(control);
    expect(choice).not.toHaveProperty('addons');
  });

  it('keeps an addon the control cannot take off the spec', () => {
    // Střelnice doplňky nebere; „collect“ tam nic nepřidá.
    expect(pickControl('shoot the aliens and collect their gems')).not.toHaveProperty('addons');
  });

  it('drafts a spec with both mechanics that the bot still wins', () => {
    for (const sentence of ['jump and shoot the zombies', 'a runner collecting coins chased by a bear']) {
      const spec = legacyDraft(sentence, 7);
      expect(spec.addons, sentence).toBeDefined();
      const built = arcadeWorldOf(spec, 7);
      if (!built.ok) throw new Error(built.issues.join('; '));
      expect(verifyArcade(built.world).publishEligible, sentence).toBe(true);
    }
    expect(legacyDraft('jump and shoot the zombies', 7).tutorial.controlsHint).toMatch(/Fire to shoot/);
  });

  // P38: živý návrh jde přes žánr – skok nese skákačku, střelba jede jako doplněk, a robot hru pořád vyhraje.
  it.each(['a jumping game where you shoot animals in the forest', 'jump and shoot the zombies'])('genre draft: %s → platformer with +shoot', (sentence) => {
    const drafted = draftGameSpecWithMeta(sentence);
    expect(drafted.genre?.genre).toBe('platformer');
    expect(drafted.genre?.cast).toContainEqual(expect.objectContaining({ does: 'shoot_at' }));
    expect(drafted.spec.control).toBe('platform');
    expect(drafted.spec.addons).toContain('shoot');
    const built = arcadeWorldOf(drafted.spec, 7);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(verifyArcade(built.world).publishEligible).toBe(true);
  });

  it('shooting alone stays a shooter', () => {
    expect(draftGameSpecWithMeta('shoot the aliens before they land').genre).toMatchObject({ genre: 'shooter' });
  });

  // Naměřeno 24. 9. 2026: 5 z 5 (s006, s010, s012, s029 sbírají, s014 honí).
  // s012 („run on a rainbow road and collect stars“) potřebovala slova mezi slovesy.
  it('gives both mechanics to 5 of 5 corpus sentences with a move and a second verb (pin, ≥ 70 %)', () => {
    const twoVerb = corpus.filter((e) => MOVE.test(e.text.toLowerCase()) && SECOND.test(e.text.toLowerCase()));
    const both = twoVerb.filter((e) => (pickControl(e.text.toLowerCase())?.addons?.length ?? 0) > 0);
    expect(twoVerb).toHaveLength(5);
    expect(both.map((e) => e.id)).toEqual(['s006', 's010', 's012', 's014', 's029']);
    expect(both.length / twoVerb.length).toBeGreaterThanOrEqual(0.7);
  });
});
