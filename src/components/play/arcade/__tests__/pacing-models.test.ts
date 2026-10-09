/**
 * Těla průběhu P45C (chování, boss, terč střelnice) se kreslí modelem nepřítele z věty (R1). Co by se četlo
 * dobře a lhalo: náhradní kvádr – „něco tam je“ a test na počet těl projde. Druhy chování model v katalogu
 * nemají (`flanker-lod1.glb` neleží nikde), takže test pro každou živou buňku s průběhem ověří, že scéna
 * (`modelIdOf` ve `World.tsx`, `partOf` + `modelOf` v aréně) sáhne po modelu, který opravdu existuje.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { ROLE, nativeRule } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import { chaserModel, enemyModel, heroModel, modelPath, riggedCharacter } from '@/play/arcade/models';
import type { BehaviourRef } from '@/play/arcade/pieces/behaviours';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

import { modelIdOf } from '../World';
import { modelOf, partOf } from '../arena/ArenaScene';
import { type BodyView, PACING_KINDS, bodiesOf } from '../bodies';

/** Model, který scéna opravdu načte: riggovaná postava, nebo GLB v `public/`. */
const exists = (id: string): boolean => riggedCharacter(id) !== undefined || existsSync(join(process.cwd(), 'public', modelPath(id)));

interface Paced {
  readonly id: string;
  readonly cast: { readonly player: string; readonly enemy: string; readonly chaser: string; readonly props: Record<string, never> };
  /** Předlohy chování a bosse (pravidlo `pacing`) a jejich pohled scény. */
  readonly foes: readonly BodyView[];
}

function pacedCells(): Paced[] {
  const out: Paced[] = [];
  for (const cell of liveCells()) {
    const spec = compileRecipe(assemblyOfCell(cell));
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) continue;
    const refs = (nativeRule(made.world.rules, 'pacing')?.params.behaviours ?? []) as readonly BehaviourRef[];
    if (refs.length === 0) continue;
    const state = instantiate(made.world);
    const views = bodiesOf({ world: made.world, state: () => state });
    out.push({ id: cell.id, cast: { player: heroModel(spec), enemy: enemyModel(spec), chaser: chaserModel(spec), props: {} }, foes: refs.map((ref) => views[ref.template]!) });
  }
  return out;
}

describe('pacing bodies draw the sentence enemy, not fallback boxes', () => {
  const cells = pacedCells();

  it('every behaviour kind and the boss has no catalog model of its own and draws the sentence enemy', () => {
    expect(PACING_KINDS).toEqual(new Set(['flanker', 'sniper', 'ambusher', 'guardian', 'swarm', 'boss']));
    expect([...PACING_KINDS].filter(exists)).toEqual([]);
    // Flanker a hejno živé buňky zatím nelosují (T12): pohled každého druhu s rolí nástrahy.
    const cast = cells[0]!.cast;
    for (const kind of PACING_KINDS) {
      const view: BodyView = { index: 5, kind, role: ROLE.hazard, w: 0.9, h: 1.5, d: 0.9 };
      expect(modelIdOf(view, cast), kind).toBe(cast.chaser);
      expect(partOf(view), kind).toBe('foe');
    }
    const live = new Set(cells.flatMap((cell) => cell.foes.map((view) => view.kind)));
    expect([...live].filter((kind) => !PACING_KINDS.has(kind))).toEqual([]);
    expect(live.has('boss')).toBe(true);
  });

  it.each(cells.map((cell) => [cell.id, cell] as const))('%s: every pacing body resolves to a real model in both scenes', (_id, cell) => {
    expect(exists(cell.cast.chaser)).toBe(true);
    for (const view of cell.foes) {
      expect(PACING_KINDS.has(view.kind), view.kind).toBe(true);
      expect(modelIdOf(view, cell.cast), view.kind).toBe(cell.cast.chaser);
      expect(partOf(view), view.kind).toBe('foe');
      expect(modelOf(partOf(view), cell.cast), view.kind).toBe(cell.cast.chaser);
    }
  });

  it('the boss is drawn bigger: its body box is larger than every other foe of its game', () => {
    let bosses = 0;
    for (const cell of cells) {
      const boss = cell.foes.find((view) => view.kind === 'boss');
      if (boss === undefined) continue;
      bosses += 1;
      for (const view of cell.foes.filter((other) => other.kind !== 'boss')) expect(boss.h, `${cell.id} ${view.kind}`).toBeGreaterThan(view.h);
    }
    expect(bosses).toBeGreaterThan(0);
  });
});
