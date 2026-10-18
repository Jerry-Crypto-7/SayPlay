/**
 * Seznam kreslených těl (P28B T2): střela, kterou jádro za běhu přidá
 * `spawn()`, musí v seznamu být – seznam ze startu ji neznal a střelnice
 * střílela neviditelně.
 */

import { describe, expect, it } from 'vitest';

import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { draftGameSpec } from '@/play/draft/draft';
import { readGameSpec } from '@/play/spec';

import { bodiesOf, bodiesStale, drawsNothing } from '../bodies';
import { TICK_MS, createArcadeSession } from '../session';

const range = (() => {
  const spec = readGameSpec(shooterFixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
})();

describe('drawn bodies', () => {
  it('a shot spawned mid-run makes the list stale and the rebuilt list holds it', () => {
    const session = createArcadeSession(range);
    const before = bodiesOf(session);
    expect(bodiesStale(before, session)).toBe(false);
    session.press(BUTTON.TAP);
    session.advance(TICK_MS * 2);
    const state = session.state();
    const count = state[HEADER.bodyCount] as number;
    const spawned = Array.from({ length: count }, (_, index) => index).filter(
      (index) => index >= before.length && ((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive) !== 0,
    );
    expect(spawned.length).toBeGreaterThan(0);
    expect(bodiesStale(before, session)).toBe(true);
    const after = bodiesOf(session);
    for (const index of spawned) expect(after[index]).toMatchObject({ index, role: ROLE.projectile });
    expect(bodiesStale(after, session)).toBe(false);
  });

  it('a restart shrinks the list back', () => {
    const session = createArcadeSession(range);
    const start = bodiesOf(session).length;
    session.press(BUTTON.TAP);
    session.advance(TICK_MS * 2);
    const grown = bodiesOf(session);
    session.restart();
    expect(bodiesStale(grown, session)).toBe(true);
    expect(bodiesOf(session)).toHaveLength(start);
  });

  // Počítadlo komba (P36A T5) nese druh hrdiny: kreslené by stahovalo `player-lod1.glb`, které neexistuje (404 v konzoli).
  it('the combo counter of a scored game draws nothing, every real body is drawn', () => {
    const spec = draftGameSpec('a knight running and jumping over hurdles');
    expect(spec.scoring).toBeDefined();
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    const views = bodiesOf(createArcadeSession(built.world));
    const hidden = views.filter(drawsNothing);
    // Logická těla (P45B – věta dostane šablonu s logikou) jsou skrytá taky; drží je test níž.
    // Zbytek: počítadlo průběhu P45C (běžec je nová hra s křivkou), počítadlo tepu trati (P51 T7), počítadlo power-upů P46C a za nimi počítadlo komba.
    expect(hidden.filter((view) => view.role !== ROLE.logic)).toEqual([expect.objectContaining({ role: ROLE.obstacle, kind: 'player', w: 1 / UNIT }), expect.objectContaining({ role: ROLE.obstacle, kind: 'player', w: 1 / UNIT }), expect.objectContaining({ role: ROLE.thing, kind: 'player' }), expect.objectContaining({ role: ROLE.thing, kind: 'player' })]);
    expect(views.filter((view) => !drawsNothing(view)).map((view) => view.role)).toContain(ROLE.player);
    expect(views.filter((view) => !drawsNothing(view)).map((view) => view.role)).toContain(ROLE.powerup);
  });

  it('the logic body of an arcade-v3 world draws nothing, so no player model mounts for it (P45B R2)', () => {
    const spec = draftGameSpec('toaster tornado');
    expect(spec.logic).toBeDefined();
    const built = arcadeWorldOf(spec, 1);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(built.world.runtimeVersion).toBe('arcade-v3');
    const views = bodiesOf(createArcadeSession(built.world));
    expect(views.filter((view) => view.role === ROLE.logic).length).toBeGreaterThan(0);
    expect(views.filter((view) => !drawsNothing(view)).map((view) => view.role)).not.toContain(ROLE.logic);
  });
});
