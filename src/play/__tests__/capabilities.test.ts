/**
 * Tabulka schopností (P26 T5) proti kódu, který hru opravdu staví a kreslí.
 *
 * Buňka „čte“ musí změnit svět (`canonicalHash` z `arcadeWorldOf`) nebo model,
 * který vykreslení zvolí (`models.ts`); buňka „nečte“ nesmí změnit nic. Když
 * tabulka zalže jedním směrem, zčervená jedna z těch dvou skupin.
 */

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import collectExit from '../__fixtures__/collect_exit.json';
import arena from '../arcade/__fixtures__/arena.json';
import duel from '../arcade/__fixtures__/duel.json';
import flap from '../arcade/__fixtures__/flap.json';
import platform from '../arcade/__fixtures__/platform.json';
import rhythm from '../arcade/__fixtures__/rhythm.json';
import runner from '../arcade/__fixtures__/runner.json';
import shooter from '../arcade/__fixtures__/shooter.json';
import steer from '../arcade/__fixtures__/steer.json';
import throwGame from '../arcade/__fixtures__/throw.json';
import timing from '../arcade/__fixtures__/timing.json';
import { arcadeWorldOf } from '../arcade/compile';
import { enemyModel, heroModel, propModels } from '../arcade/models';
import { CAPABILITIES, readsLabel, readsMechanic, unreadItems } from '../capabilities';
import { blockingIssues, critique } from '../director/critic';
import { repairDeterministically } from '../director/repair';
import { lookOf } from '../arcade/look';
import { readGameSpec, type ControlId, type GameSpecV1 } from '../spec';

/**
 * Ovládání, jejichž podklad (`Backdrop` v `ArcadeStage.tsx`) kreslí sadu prostředí.
 * Závod, aréna, načasování, rytmus a souboj mají vlastní scénu bez sad.
 */
const SCENERY_CONTROLS: ReadonlySet<ControlId> = new Set(['runner', 'platform', 'flap', 'shooter', 'throw']);

const FIXTURES: readonly (readonly [Exclude<ControlId, 'tap_go'>, GameSpecV1])[] = [
  ['runner', runner],
  ['platform', platform],
  ['flap', flap],
  ['steer', steer],
  ['move_free', arena],
  ['shooter', shooter],
  ['throw', throwGame],
  ['timing', timing],
  ['rhythm', rhythm],
  ['duel', duel],
] as unknown as readonly (readonly [Exclude<ControlId, 'tap_go'>, GameSpecV1])[];

const clone = (spec: GameSpecV1): GameSpecV1 => JSON.parse(JSON.stringify(spec)) as GameSpecV1;

function worldHash(spec: GameSpecV1): string {
  const made = arcadeWorldOf(spec, 7);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return canonicalHash(made.world);
}

/** Spec s mechanikou nastavenou tak, aby ji kompilátor, pokud ji čte, musel promítnout. */
function withMechanic(spec: GameSpecV1, id: 'health' | 'timer'): GameSpecV1 {
  const next = clone(spec);
  const params = id === 'health' ? { max: 5 } : { id: 'clock', seconds: 25, onEnd: 'lose' };
  next.mechanics = [...next.mechanics.filter((m) => m.id !== id), { id, params } as GameSpecV1['mechanics'][number]];
  return next;
}

const pick = (spec: GameSpecV1): string => `${heroModel(spec)}|${enemyModel(spec)}|${JSON.stringify(propModels(spec))}`;

describe('capability table against the arcade compiler and renderer', () => {
  for (const [control, fixture] of FIXTURES) {
    const base = readGameSpec(fixture);
    if (!base.ok) throw new Error(`${control}: ${base.issues.join('; ')}`);
    const spec = base.value;

    it(`${control}: the template carries nothing the control ignores`, () => {
      expect(spec.control).toBe(control);
      expect(unreadItems(spec).filter((item) => item.kind === 'mechanic')).toEqual([]);
    });

    for (const id of ['health', 'timer'] as const) {
      it(`${control}: ${id} is ${readsMechanic(control, id) ? 'read – the world changes' : 'not read – the world stays'}`, () => {
        const plain = clone(spec);
        plain.mechanics = plain.mechanics.filter((m) => m.id !== id);
        const changed = worldHash(withMechanic(plain, id)) !== worldHash(plain);
        expect(changed).toBe(readsMechanic(control, id));
      });
    }

    it(`${control}: role counts and theme.setting never change the world`, () => {
      const next = clone(spec);
      next.theme.setting = 'a completely different place';
      next.roles = next.roles.map((role) => (role.kind === 'player' ? role : { ...role, count: 1 }));
      expect(CAPABILITIES[control].counts).toBe(false);
      expect(worldHash(next)).toBe(worldHash(spec));
    });

    // P26 T11: prostředí mění scénu (sadu), ne svět – jen u ovládání, jejichž scéna sadu kreslí.
    it(`${control}: theme.setting picks the scene set exactly when the table says so`, () => {
      const scenes = new Set(['on a glacier', 'on Mars', 'in a supermarket'].map((setting) => lookOf({ ...spec.theme, setting })));
      expect(scenes.size).toBe(3);
      expect(CAPABILITIES[control].setting).toBe(SCENERY_CONTROLS.has(control));
    });

    it(`${control}: a label the table marks as read changes the rendered model, others do not`, () => {
      for (const [index, role] of spec.roles.entries()) {
        const next = clone(spec);
        // `fox` je v katalogu; u závodu přepíná auto na letadlo `plane`.
        next.roles[index] = { ...role, label: control === 'steer' ? 'plane' : 'fox' };
        const changed = pick(next) !== pick(spec) || worldHash(next) !== worldHash(spec);
        // Kreslení čte hráče, `enemy` a rekvizity z `PROP_ROLES`; tabulka u P25H ovládání tvrdí „nic“, a to kód
        // vybírá model jen pro postavu, kterou ta ovládání nekreslí – tady proto jen směr „čte“.
        if (readsLabel(control, role)) expect(changed, `${control} ${role.id}`).toBe(true);
        else if (role.kind !== 'player') expect(changed, `${control} ${role.id}`).toBe(false);
      }
    });
  }
});

describe('critic and repair drop what the control does not play', () => {
  it('a runner with a grid hazard is blocked as UNSUPPORTED and repaired by removing it', () => {
    const spec = clone(runner as GameSpecV1);
    spec.mechanics = [{ id: 'hazard_zone', params: { role: 'obstacle', effect: 'lose' } }] as GameSpecV1['mechanics'];
    const read = readGameSpec(spec);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const blocking = blockingIssues(critique(read.value));
    expect(blocking.map((issue) => [issue.code, issue.path])).toEqual([['UNSUPPORTED', '/mechanics/0']]);
    const repaired = repairDeterministically(read.value, blocking);
    expect(repaired?.spec.mechanics).toEqual([]);
    expect(blockingIssues(critique(repaired!.spec))).toEqual([]);
  });

  it('a shooter keeps lives but loses defeat, and still reads', () => {
    const spec = clone(shooter as GameSpecV1);
    spec.mechanics = [
      { id: 'defeat', params: { role: 'target', count: 4, hitsPerTarget: 1 } },
      { id: 'health', params: { max: 3 } },
    ] as GameSpecV1['mechanics'];
    const read = readGameSpec(spec);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const repaired = repairDeterministically(read.value, critique(read.value));
    expect(repaired?.spec.mechanics.map((m) => m.id)).toEqual(['health']);
  });

  it('an unread label only warns', () => {
    const read = readGameSpec(duel);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const issues = critique(read.value);
    const labels = issues.filter((issue) => issue.code === 'UNSUPPORTED' && issue.path.startsWith('/roles/'));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((issue) => issue.severity === 'warn')).toBe(true);
  });

  it('the grid keeps its own checks and has nothing unread', () => {
    const read = readGameSpec(collectExit);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(unreadItems(read.value)).toEqual([]);
    expect(critique(read.value).filter((issue) => issue.code === 'UNSUPPORTED')).toEqual([]);
    const idle = clone(read.value);
    idle.mechanics = [{ id: 'timer', params: { id: 'clock', seconds: 60, onEnd: 'lose' } }] as GameSpecV1['mechanics'];
    expect(blockingIssues(critique(idle)).map((issue) => issue.code)).toContain('NO_AGENCY');
  });
});

// P26D T2: doplněk smí jen ovládání, které ho umí zahrát. Životy = ovládání, které čte `health`;
// sbírání = trať k cíli s mincemi (aréna potravu sbírá už sama, závod ani hod mince nemá).
describe('addons each control accepts (P26D T2)', () => {
  it('matches the plan table', () => {
    const accepting = (addon: string): string[] =>
      Object.entries(CAPABILITIES)
        .filter(([, capability]) => (capability.addons as readonly string[]).includes(addon))
        .map(([control]) => control)
        .sort();
    expect(accepting('shoot')).toEqual(['flap', 'move_free', 'platform', 'runner']);
    expect(accepting('collect')).toEqual(['flap', 'platform', 'runner']);
    expect(accepting('chaser')).toEqual(['move_free', 'platform', 'runner']);
    expect(accepting('lives')).toEqual(Object.keys(CAPABILITIES).filter((control) => control !== 'tap_go' && readsMechanic(control as ControlId, 'health')).sort());
  });
});
