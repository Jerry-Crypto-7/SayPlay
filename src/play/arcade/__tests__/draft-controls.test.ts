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
import { readGameSpec } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { verifyArcade } from '../verify';

interface DemandEntry {
  readonly id: string;
  readonly text: string;
  readonly verb: string;
}

const corpus = JSON.parse(readFileSync(new URL('../../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as DemandEntry[];

function runnerIds(verb: (v: string) => boolean): string[] {
  return corpus.filter((e) => verb(e.verb) && pickControl(e.text.toLowerCase()) !== null).map((e) => e.id);
}

describe('draft control choice', () => {
  it('picks the runner for 14 of 16 runner sentences and for no sentence of another control (pin)', () => {
    expect(corpus.filter((e) => e.verb === 'runner')).toHaveLength(16);
    expect(runnerIds((v) => v === 'runner')).toHaveLength(14);
    expect(runnerIds((v) => v !== 'runner' && v !== 'platform')).toEqual([]);
    expect(runnerIds((v) => v === 'platform')).toEqual(['s001', 's024']);
  });

  it('reads the obstacle density from quantifiers', () => {
    expect(pickControl('jumping arcade game with a lot of obstacles')?.density).toBe('high');
    expect(pickControl('an easy endless runner')?.density).toBe('low');
    expect(pickControl('endless runner in a neon city')?.density).toBeNull();
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
    expect(spec.controlParams?.density).toBe('high');
    expect(readGameSpec(spec).ok).toBe(true);
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(verifyArcade(built.world).publishEligible).toBe(true);
  });
});
