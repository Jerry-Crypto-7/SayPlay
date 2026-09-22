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

  // P25C T7, naměřeno 22. 9. 2026: plošinovka 13/15, cizí štítek jen s103
  // („a ball bounces down a helix tower“, načasování), poletování s035.
  it('picks the platformer for 13 of 15 platform sentences and flap for the flappy one (pin)', () => {
    expect(corpus.filter((e) => e.verb === 'platform')).toHaveLength(15);
    expect(idsPicking('platform', (v) => v === 'platform')).toHaveLength(13);
    expect(idsPicking('platform', (v) => v !== 'platform')).toEqual(['s103']);
    expect(idsPicking('flap', () => true)).toEqual(['s035']);
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
