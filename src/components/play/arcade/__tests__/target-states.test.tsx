/**
 * Stavy cílů úkolu (P32G T5): každý druh slovesa v každém stavu kreslí jiný
 * strom objektů. Stav, který vzhled nezmění, vypadá jako hotový předmět –
 * hráč nepozná, co ještě zbývá. Snapshot je struktura, ne pixely.
 */

import { type ReactElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { ArcadeWorld } from '@/play/arcade/contract';
import { buildWorld } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { questSpatial, questStation } from '@/play/arcade/pieces/quest';
import { KIND_STATES, type VerbKind } from '@/play/genre/quest';

import type { TargetBody } from '../arena/TargetsMount';
import { questTargets, targetParts } from '../quest/TargetStates';
import { MAX_LIGHTS, lightsOf, questVerbOf, risenBursts } from '../quest/verbFx';

const KINDS = Object.keys(KIND_STATES) as VerbKind[];

const target = (index: number, state: number, x = 0, z = 0): TargetBody => ({ index, kind: 'target', x, y: 0, z, w: 0.8, h: 1.2, d: 0.8, state });

/** Strom elementů bez funkcí: typ, hodnoty props a děti. Komponenty s háčky se nevolají, stačí jméno a props. */
function structureOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.filter((child) => child !== null && child !== undefined && child !== false).map(structureOf);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  const type = typeof element.type === 'string' ? element.type : ((element.type as { name?: string }).name ?? 'anonymous');
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element.props)) {
    if (key === 'children' || typeof value === 'function') continue;
    props[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && !('isColor' in value) ? structureOf(value) : value;
  }
  return { type, props, children: structureOf(element.props.children ?? []) };
}

const shape = (kind: VerbKind | null, state: number, states: number): string => JSON.stringify(structureOf(targetParts(target(1, state), kind, states)));

function spatialWorld(verb: string, states: 2 | 3): ArcadeWorld {
  const parts = questSpatial.parts(1, questSpatial.params.parse({ verb, states }), undefined);
  const built = buildWorld({ seed: 1, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('quest target states (P32G T5)', () => {
  it('draws every verb kind in every state as a different object tree', () => {
    const shapes = new Map<string, string>();
    for (const kind of KINDS) for (let state = 0; state < KIND_STATES[kind]; state += 1) shapes.set(`${kind}:${String(state)}`, shape(kind, state, KIND_STATES[kind]));
    expect(new Set(shapes.values()).size).toBe(shapes.size);
    // Sloveso bez druhu („paint“) kreslí tvar v paletě – i ten se stavem mění, se dvěma i třemi stavy.
    for (const states of [2, 3]) {
      const plain = Array.from({ length: states }, (_, state) => shape(null, state, states));
      expect(new Set(plain).size).toBe(states);
      plain.forEach((json, state) => shapes.set(`plain/${String(states)}:${String(state)}`, json));
    }
    expect(Object.fromEntries([...shapes].map(([key, json]) => [key, JSON.parse(json) as unknown]))).toMatchSnapshot();
  });

  it('a quest world draws its targets by the verb of its interact rule; other worlds keep the outline stub', () => {
    const firefighter = spatialWorld('put-out', 3);
    expect(questVerbOf(firefighter)).toMatchObject({ kind: 'fire', states: 3 });
    expect(questVerbOf(firefighter)?.interact.order).toBeUndefined();
    const layer = questTargets(firefighter);
    expect(layer).toBeDefined();
    const drawn = layer!([target(1, 0)]) as ReactElement<{ readonly kind: VerbKind; readonly states: number }>;
    expect(drawn.props).toMatchObject({ kind: 'fire', states: 3 });

    const painter = spatialWorld('paint', 2);
    expect(questVerbOf(painter)).toMatchObject({ kind: null, states: 2 });

    const station = questStation.parts(1, questStation.params.parse({ verb: 'flip', states: 3 }), undefined);
    const cook = buildWorld({ seed: 1, control: station.control, rules: station.rules, bot: station.bot, level: station.level }, ARCADE_LIBRARY);
    if (!cook.ok) throw new Error(cook.issues.join('; '));
    // Stanoviště: cíle po řadě a okno připravenosti – podle toho scéna přidá pult a blízkou kameru.
    expect(questVerbOf(cook.world)).toMatchObject({ kind: 'cook', states: 3, interact: { order: true, ready: { after: 90, window: 60 } } });

    expect(questTargets({ ...firefighter, rules: [] })).toBeUndefined();
  });

  it('bursts once when a target steps forward, never on the first frame or a restart', () => {
    const seen = new Map<number, number>();
    expect(risenBursts(seen, [target(1, 0), target(2, 0)], 'fire')).toEqual([]);
    const first = risenBursts(seen, [target(1, 1, 2, 3), target(2, 0)], 'fire');
    expect(first).toHaveLength(1);
    expect(first[0]!.at[0]).toBe(2);
    expect(first[0]!.at[2]).toBe(3);
    // Týž stav další snímek: nic nového.
    expect(risenBursts(seen, [target(1, 1, 2, 3), target(2, 0)], 'fire')).toEqual([]);
    // Restart vrátí stavy na 0 – to není přechod slovesem.
    expect(risenBursts(seen, [target(1, 0, 2, 3), target(2, 0)], 'fire')).toEqual([]);
    expect(risenBursts(seen, [target(1, 1, 2, 3), target(2, 2)], 'fire')).toHaveLength(2);
    // Sloveso bez druhu dá taky záblesk.
    expect(risenBursts(new Map([[1, 0]]), [target(1, 1)], null)).toHaveLength(1);
  });

  it('lights at most four burning targets, nearest the camera first; the rest only glow', () => {
    const burning = [0, 1, 2, 3, 4, 5].map((i) => target(i, 0, i * 10, 0));
    const lights = lightsOf(burning, 'fire', { x: 55, z: 0 });
    expect(lights).toHaveLength(MAX_LIGHTS);
    expect(lights.map((light) => light.x)).toEqual([50, 40, 30, 20]);
    // Kouřící a uhašené stromy nesvítí, nezapálená svíčka taky ne, zapálená ano.
    expect(lightsOf([target(0, 2), target(1, 1)], 'fire', { x: 0, z: 0 })).toHaveLength(0);
    expect(lightsOf([target(0, 0), target(1, 1)], 'flame', { x: 0, z: 0 })).toHaveLength(1);
  });
});
