/**
 * Místo pro vrstvu cílů (P32E T7): vrstva úkolu (P32G) dostane právě živá těla
 * s rolí cíle, v metrech scény (x zrcadlené) a se stavem 0..2 ze stavu jádra.
 * Nepřítel, věc nebo plot ve vrstvě by dostal model cíle; špatně čtený stav
 * vypadá jako hotový předmět.
 */

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { BODY, FLAG, bodyBase, setTargetState } from '@/play/arcade/contract';
import { buildWorld, instantiate } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';

import { targetOutlines, targetsOf } from '../arena/TargetsMount';
import { bodiesOf } from '../bodies';

const PLAYER = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false } as const;
const target = (kind: string, x: number, z: number) => ({ role: 'target', kind, x, y: 0, z, w: 800, h: 1200, d: 600, solid: false }) as const;

/** Hráč, tři živé cíle, mrtvý cíl a těla jiných rolí mezi nimi. */
function scene() {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'fight', params: {} },
      rules: [],
      bot: { id: 'fight_bot', params: {} },
      level: {
        bodies: [
          PLAYER,
          target('candle', 3000, 2000),
          { role: 'enemy', kind: 'ghost', x: 6000, y: 0, z: 0, w: 900, h: 1500, d: 900, solid: false, hp: 3 },
          target('candle', -4000, 5000),
          { role: 'collectible', kind: 'coin', x: 1000, y: 0, z: 1000, w: 500, h: 500, d: 500, solid: false },
          { role: 'obstacle', kind: 'crate', x: 2000, y: 0, z: -2000, w: 1000, h: 1000, d: 1000, solid: true },
          target('tree', 7000, -3000),
          target('tree', 9000, 9000),
        ],
        length: 0,
      },
    },
    ARCADE_LIBRARY,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  const state = instantiate(built.world);
  setTargetState(state, 3, 1);
  setTargetState(state, 6, 2);
  // Stav cíle v bitech jiného těla vrstvu nezajímá.
  setTargetState(state, 2, 2);
  // Cíl se od startu posunul: poloha ze snímku, ne z úrovně.
  state[bodyBase(6) + BODY.x] = 7500;
  // Mrtvý cíl scéna nekreslí.
  state[bodyBase(7) + BODY.flags] = (state[bodyBase(7) + BODY.flags] as number) & ~FLAG.alive;
  return { state, views: bodiesOf({ world: built.world, state: () => state }) };
}

describe('targets mount (P32E T7)', () => {
  it('passes exactly the live target bodies, in scene metres, with their state 0..2', () => {
    const { state, views } = scene();
    const size = { w: 0.8, h: 1.2, d: 0.6 };
    expect(targetsOf(views, state)).toEqual([
      { index: 1, kind: 'candle', x: -3, y: 0, z: 2, ...size, state: 0 },
      { index: 3, kind: 'candle', x: 4, y: 0, z: 5, ...size, state: 1 },
      { index: 6, kind: 'tree', x: -7.5, y: 0, z: -3, ...size, state: 2 },
    ]);
  });

  it('without the quest layer the stub outlines each target on the floor under it, coloured by state', () => {
    const { state, views } = scene();
    const targets = targetsOf(views, state);
    type Outline = ReactElement<{ readonly position: readonly number[]; readonly children: readonly ReactElement<{ readonly color?: string }>[] }>;
    const outlines = targetOutlines(targets) as readonly Outline[];
    expect(outlines.map((outline) => outline.props.position)).toEqual(targets.map((one) => [one.x, 0.02, one.z]));
    const colours = outlines.map((outline) => outline.props.children[1]?.props.color);
    expect(new Set(colours).size).toBe(3);
  });
});
