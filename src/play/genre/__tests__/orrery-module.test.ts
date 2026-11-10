/**
 * Modul typu Klikací simulace (P83C T2): věci z věty jsou role `orrery0`–`orrery8` s popisky, parametry jdou do generátoru
 * `orrery_scene` a hra projde publikační bránou (`compileArcade` + `verifyArcade`, totéž co `POST /api/play/games`)
 * ve všech čtyřech uspořádáních a třech odpovědích na klepnutí.
 */
import { describe, expect, it } from 'vitest';

import { compileArcade } from '../../arcade/compile';
import { ORRERY_ANSWERS, ORRERY_LAYOUTS } from '../../arcade/pieces/orrery';
import { verifyArcade } from '../../arcade/verify';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { genreOfWorld } from '../../xr/modes';
import { type GenreSpecOf, genreSpecSchema } from '../contract';
import { orreryGenre } from '../orrery';

const PLANETS = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter'];

function specOf(labels: readonly string[], params: Readonly<Record<string, number>> = {}): GenreSpecOf<'orrery'> {
  return genreSpecSchema.parse({
    genre: 'orrery',
    mode: 'default',
    hero: 'explorer',
    setting: 'solar system',
    cast: labels.map((label) => ({ label, does: 'scenery' })),
    params,
  }) as GenreSpecOf<'orrery'>;
}

const tuningOf = (spec: GameSpecV1): unknown => (spec.controlParams as { tuning?: unknown } | undefined)?.tuning;

describe('orrery genre module', () => {
  it('each thing the sentence names is one target role with its label, in order', () => {
    const spec = orreryGenre.compile(specOf(PLANETS, { hub: 1 }));
    expect(readGameSpec(spec).ok).toBe(true);
    expect(spec.control).toBe('orrery');
    expect(spec.roles.filter((role) => role.kind === 'target').map((role) => [role.id, role.label])).toEqual(PLANETS.map((label, index) => [`orrery${String(index)}`, label]));
    expect(tuningOf(spec)).toEqual({ things: 6, layout: 'orbit', answer: 'glow', hub: true });
    expect(spec.objective).toMatchObject({ kind: 'collect', count: 6 });
  });

  it('one named thing repeats up to the default count; params pick layout and answer', () => {
    const spec = orreryGenre.compile(specOf(['flower'], { layout: 3, answer: 2 }));
    expect(spec.roles.filter((role) => role.kind === 'target').map((role) => role.label)).toEqual(['flower', 'flower', 'flower', 'flower', 'flower']);
    expect(tuningOf(spec)).toEqual({ things: 5, layout: 'scatter', answer: 'bigger', hub: false });
  });

  it('the draft keeps only things to explore, never a foe', () => {
    const fill = orreryGenre.draftFill('a garden with roses and tulips and a bee', {
      hero: null,
      setting: 'garden',
      roles: [
        { kind: 'collectible', label: 'rose' },
        { kind: 'threat', label: 'bee' },
      ],
    } as never);
    expect((fill.cast ?? []).every((item) => item.does === 'scenery' || item.does === 'collect')).toBe(true);
  });

  it('every layout and every answer passes the publication gate: the bot wakes all, idle does not win', () => {
    for (const [layout, name] of ORRERY_LAYOUTS.entries()) {
      for (const [answer] of ORRERY_ANSWERS.entries()) {
        const spec = orreryGenre.compile(specOf(PLANETS.slice(0, 4 + layout), { layout, answer, hub: layout < 2 ? 1 : 0 }));
        const made = compileArcade(spec, 7 + layout);
        if (!made.ok || made.value.arcade === undefined) throw new Error(`${name}/${String(answer)}: ${JSON.stringify(made)}`);
        const verdict = verifyArcade(made.value.arcade);
        expect(verdict.failures, `${name}/${String(answer)}`).toEqual([]);
        expect(verdict.publishEligible, `${name}/${String(answer)}`).toBe(true);
        expect(verdict.idle.outcome, `${name}/${String(answer)}`).not.toBe('won');
        expect(genreOfWorld(made.value.arcade)).toBe('orrery');
      }
    }
  }, 300_000);
});
