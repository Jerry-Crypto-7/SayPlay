/**
 * Nečinný hráč publikované hry slučování (P54C, e2e `play-merge.spec.ts`): hru buňky `merge.default` sestaví tatáž
 * cesta jako dveře `/api/play/games` se specem – čtení specu, semínka odvozená z něj a `compileGame` – a běh bez
 * jediného vstupu musí prohrát přetečením nádoby dřív, než doběhnou hodiny.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileGame } from '@/play/compile';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { readGameSpec } from '@/play/spec';

import { ARCADE_HZ, ARCADE_LIMITS, HEADER, NO_INPUT } from '../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { MERGE, mergesOf } from '../pieces/merge-drop';
import { releasePhysics } from '../physics/step';
import { loadRapier } from '../physics/world';

beforeAll(async () => {
  await loadRapier();
});

describe('idle player of the published merge game', () => {
  it('merges nothing and loses by overflow before the clock runs out', () => {
    const cell = liveCells().find((candidate) => candidate.id === 'merge.default');
    if (cell === undefined) throw new Error('merge.default is not a live cell');
    const read = readGameSpec(compileRecipe(assemblyOfCell(cell)));
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = compileGame(read.value, derivedSeeds(seedFrom(read.value))[0]);
    if (!compiled.ok) throw new Error(compiled.issues.join('; '));
    const world = compiled.value.arcade;
    if (world === undefined) throw new Error('merge compiles to an arcade world');
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < ARCADE_LIMITS.maxTicks) step(state, NO_INPUT, program);
    releasePhysics(state);
    expect(outcomeOf(state)).toBe('lost');
    expect(mergesOf(state)).toBe(0);
    expect(state[HEADER.tick] as number).toBeLessThan(MERGE.seconds * ARCADE_HZ);
  }, 120_000);
});
