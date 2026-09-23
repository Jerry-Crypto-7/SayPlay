/**
 * Návrh ze slov vybere běžce (P25A T7) – pin nad korpusem poptávky
 * (`evals/play/demand/corpus.json`, 200 vět se štítkem ovládání `verb`).
 * Naměřeno 22. 9. 2026: běžec 14/16 (s012 a s013 mají jen jedno slabé
 * slovo), cizí štítky 0, plošinovky 2/15 (s001, s024 – povolené, běžec je
 * nejbližší skákačka).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '../../draft';
import { pickControl } from '../../draft/controls';
import { type RunnerParams, readGameSpec } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { verifyArcade } from '../verify';

interface DemandEntry {
  readonly id: string;
  readonly text: string;
  readonly verb: string;
}

const corpus = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as DemandEntry[];

function idsPicking(control: string, verb: (v: string) => boolean): string[] {
  return corpus.filter((e) => verb(e.verb) && pickControl(e.text.toLowerCase())?.control === control).map((e) => e.id);
}

const density = (text: string): string | null | undefined => {
  const choice = pickControl(text);
  return choice?.control === 'runner' ? choice.density : undefined;
};

describe('draft control choice', () => {
  it('picks the runner for 14 of 16 runner sentences and for no sentence of another control (pin)', () => {
    expect(corpus.filter((e) => e.verb === 'runner')).toHaveLength(16);
    expect(idsPicking('runner', (v) => v === 'runner')).toHaveLength(14);
    expect(idsPicking('runner', (v) => v !== 'runner' && v !== 'platform')).toEqual([]);
    // Obecné skákání s překážkami a parkour – běžec má přednost (P25C T7).
    expect(idsPicking('runner', (v) => v === 'platform')).toEqual(['s001', 's024']);
  });

  // P25C T7, naměřeno 22. 9. 2026: plošinovka 13/15, poletování s035. Helix
  // věž (s103) od P25H T5 bere načasování, cizí štítek plošinovce nezbyl.
  it('picks the platformer for 13 of 15 platform sentences and flap for the flappy one (pin)', () => {
    expect(corpus.filter((e) => e.verb === 'platform')).toHaveLength(15);
    expect(idsPicking('platform', (v) => v === 'platform')).toHaveLength(13);
    expect(idsPicking('platform', (v) => v !== 'platform')).toEqual([]);
    expect(idsPicking('flap', () => true)).toEqual(['s035']);
  });

  // P25H T5, naměřeno 23. 9. 2026. Načasování nechytí s059 (závod šneků),
  // s095 (házení nožů = házení), s126 (slučování) a s133 (skok na lyžích);
  // jediný cizí je s108 (jenga, štítek manipulate – stavění věže sedí).
  it('picks timing, rhythm and duel for their sentences with at most 3 foreign picks (pin)', () => {
    expect(idsPicking('timing', (v) => v === 'timing')).toHaveLength(12);
    expect(idsPicking('rhythm', (v) => v === 'rhythm')).toHaveLength(6);
    expect(idsPicking('duel', (v) => v === 'melee')).toHaveLength(5);
    expect(idsPicking('timing', (v) => v !== 'timing')).toEqual(['s108']);
    expect(idsPicking('rhythm', (v) => v !== 'rhythm')).toEqual([]);
    expect(idsPicking('duel', (v) => v !== 'melee')).toEqual([]);
  });

  it('reads the timing mode and levels from the sentence', () => {
    expect(pickControl('hold to grow a bridge and let go to cross the gap')).toEqual({ control: 'timing', mode: 'bridge', speed: null });
    expect(pickControl('stack blocks as high as u can')).toEqual({ control: 'timing', mode: 'stack', speed: null });
    expect(pickControl('tap at the right time to stop the moving platform')).toEqual({ control: 'timing', mode: 'precision', speed: null });
    expect(pickControl('a hard rhythm game')).toEqual({ control: 'rhythm', density: 'dense' });
    expect(pickControl('an easy boxing match')).toEqual({ control: 'duel', difficulty: 'easy' });
    expect(pickControl('ninja running on rooftops')).not.toMatchObject({ control: 'duel' });
    expect(pickControl('cowboy duel at high noon, first to shoot wins')).toBeNull();
  });

  it('drafts timing, rhythm and duel specs that the arcade verifier publishes', () => {
    for (const [sentence, control] of [
      ['stack blocks as high as u can', 'timing'],
      ['hold to grow a bridge and let go to cross the gap', 'timing'],
      ['tap to the beat with glowing tiles', 'rhythm'],
      ['boxing match against a kangaroo', 'duel'],
      ['pillow fight in a sleepover', 'duel'],
    ] as const) {
      const spec = draftGameSpec(sentence);
      expect(spec.control, sentence).toBe(control);
      expect(readGameSpec(spec).ok).toBe(true);
      const built = arcadeWorldOf(spec, 1);
      if (!built.ok) throw new Error(built.issues.join('; '));
      expect(verifyArcade(built.world).publishEligible, sentence).toBe(true);
    }
    expect(draftGameSpec('hold to grow a bridge and let go to cross the gap').tutorial.controlsHint).toBe('Tap or Space to drop the plank.');
  });

  it('keeps genre priority: flap > runner genre > platform genre > runner words > platform words', () => {
    expect(pickControl('an endless runner where you jump between platforms')?.control).toBe('runner');
    expect(pickControl('a platformer where you run and jump over obstacles')?.control).toBe('platform');
    expect(pickControl('flappy bird but the runner is a fish')?.control).toBe('flap');
    expect(pickControl('like mario kart with bananas')).toBeNull();
    expect(pickControl('a frog must hop across the road and dodge cars')).toBeNull();
    expect(pickControl('hard obby with moving platforms and a double jump')).toEqual({ control: 'platform', difficulty: 'hard', movingPlatforms: true, doubleJump: true });
    expect(pickControl('an easy flappy game')).toEqual({ control: 'flap', difficulty: 'easy' });
  });

  it('drafts platform and flap specs that the arcade verifier publishes', () => {
    for (const [sentence, control] of [
      ['a squirrel jumping from tree to tree collecting acorns before winter', 'platform'],
      ['like flappy bird but underwater', 'flap'],
    ] as const) {
      const spec = draftGameSpec(sentence);
      expect(spec.control, sentence).toBe(control);
      expect(readGameSpec(spec).ok).toBe(true);
      const built = arcadeWorldOf(spec, 1);
      if (!built.ok) throw new Error(built.issues.join('; '));
      expect(verifyArcade(built.world).publishEligible, sentence).toBe(true);
    }
    expect(draftGameSpec('like flappy bird but underwater').roles.find((r) => r.kind === 'player')?.label).toBe('bird');
  });

  it('reads the obstacle density from quantifiers', () => {
    expect(density('jumping arcade game with a lot of obstacles')).toBe('high');
    expect(density('an easy endless runner')).toBe('low');
    expect(density('endless runner in a neon city')).toBeNull();
    expect(pickControl('run a supermarket, stock shelves')).toBeNull();
    expect(pickControl('ski jumping')).toBeNull();
  });

  // Nález revize P25A (R2): dvě slabá slova přehodila přechod a honičku na běžce.
  it('keeps crossing and chase sentences on the grid unless a genre cue says runner', () => {
    expect(pickControl('a frog must hop across the road and dodge cars')).toBeNull();
    expect(pickControl('run from the zombie and avoid the traps')).toBeNull();
    expect(draftGameSpec('A frog must hop across the road and dodge cars').archetype).toBe('hazard_crossing');
    expect(pickControl('an endless runner where you escape a giant boulder')?.control).toBe('runner');
  });

  it('drafts a valid runner spec that the arcade verifier publishes', () => {
    const spec = draftGameSpec('jumping arcade game with a lot of obstacles');
    expect(spec.control).toBe('runner');
    expect((spec.controlParams as RunnerParams | undefined)?.density).toBe('high');
    expect(readGameSpec(spec).ok).toBe(true);
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(verifyArcade(built.world).publishEligible).toBe(true);
  });
});
