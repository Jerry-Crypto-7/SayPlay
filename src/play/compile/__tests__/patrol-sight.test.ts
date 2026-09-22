/**
 * Výhled hlídky (P25E T6, dluh z revize P25B): dvě pravidla, každé izolovaně.
 *
 * - `spot` – hráč vkročí na úsek, na kterém hlídka je → prohra.
 * - `sees` – hlídka vkročí na úsek, kde stojí hráč → prohra.
 *
 * Starý test v `compile-all.test.ts` stavěl hráče na start stráže, takže
 * ho chytilo pravidlo `start` a prošel by i s oběma rozbitými. Tady v každém
 * testu zůstane jen jedno z pravidel (dotyk, `start` i druhé pravidlo jsou
 * z pravidel vyňaté) a scénář se odvodí z pohybu stráží **bez** pravidel
 * výhledu: stráž `bold` chodí trasu nezávisle na hráči. Ke každému testu
 * patří protipříklad, ve kterém stráž na úseku není – pravidlo bez podmínky
 * by ho prohrálo.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { type Runtime, createRuntime, entityPlacements, step } from '@/sim/interpreter';

import { compileSim, type SurfaceSim } from '..';
import { readGameSpec } from '../../spec';

type Cell = readonly [number, number];
type Rect = readonly [number, number, number, number];

const HORIZON = 400;

function stealthSim(): SurfaceSim {
  const raw = JSON.parse(readFileSync(new URL('../../__fixtures__/collect_exit_stealth.json', import.meta.url), 'utf8'));
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.reason);
  const result = compileSim(spec.value, 1);
  if (!result.ok) throw new Error(`${result.reason} ${result.issues.join('; ')}`);
  return result.value.sim;
}

function runtimeOf(sim: SurfaceSim): Runtime {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return createRuntime(built.world);
}

const SIGHT = /^patrol\..+\.(?:spot\d+|sees\d+|start|touch)$/;

/** Pravidla bez výhledu a dotyku, plus jen ta z nich, která test drží. */
function onlyRules(sim: SurfaceSim, keep: RegExp): SurfaceSim['rules'] {
  return Object.fromEntries(Object.entries(sim.rules).filter(([id]) => !SIGHT.test(id) || keep.test(id)));
}

const beats = (sim: SurfaceSim): [string, readonly Rect[]][] =>
  Object.entries(sim.state.zones as Record<string, readonly Rect[]>).filter(([zone]) => /_beat\d+$/.test(zone));
const inRects = (rects: readonly Rect[], [x, y]: Cell): boolean => rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h);
const beatsAt = (sim: SurfaceSim, cell: Cell): string[] => beats(sim).filter(([, rects]) => inRects(rects, cell)).map(([zone]) => zone);
const guardOf = (zone: string): string => zone.replace(/_beat\d+$/, '');
const cellOf = (runtime: Runtime, id: string): Cell => {
  const found = entityPlacements(runtime).find((entity) => entity.stableId === id);
  if (found === undefined) throw new Error(`no entity ${id}`);
  return [found.x, found.y];
};

interface Frame {
  readonly tick: number;
  readonly cells: Readonly<Record<string, Cell>>;
  readonly fired: readonly string[];
  readonly runState: string;
}

/** Odkrokuje hru a zapíše polohy hráče a stráží po každém tiku. */
function play(sim: SurfaceSim, inputs: readonly { tick: number; actionId: string; target: string }[], ticks = HORIZON): Frame[] {
  const runtime = runtimeOf(sim);
  const guards = [...new Set(beats(sim).map(([zone]) => guardOf(zone)))];
  const frames: Frame[] = [];
  for (let tick = 0; tick < ticks && runtime.runState === 'running'; tick += 1) {
    const due = inputs.filter((input) => input.tick === tick).map((input) => ({ ...input, actor: 'player' }));
    const result = step(runtime, due);
    const cells = Object.fromEntries(['player', ...guards].map((id) => [id, cellOf(runtime, id)]));
    frames.push({ tick, cells, fired: result.fired, runState: runtime.runState });
  }
  return frames;
}

/** Hráč i stráže bez výhledu: kdy hráč poprvé vkročí na úsek, a na který. */
function firstStep(sim: SurfaceSim, target: string): { tick: number; zones: string[] } | null {
  const frames = play({ ...sim, rules: onlyRules(sim, /^$/) }, [{ tick: 0, actionId: 'moveTo', target }]);
  for (const frame of frames) {
    const zones = beatsAt(sim, frame.cells.player as Cell);
    if (zones.length > 0) return { tick: frame.tick, zones };
  }
  return null;
}

/** Stráž je na úseku v daném tiku – změřeno bez pravidel výhledu a bez pohybu hráče. */
function guardOn(sim: SurfaceSim, zone: string, tick: number): boolean {
  const frames = play({ ...sim, rules: onlyRules(sim, /^$/) }, [], tick + 1);
  const cell = frames[tick]?.cells[guardOf(zone)];
  return cell !== undefined && inRects(beats(sim).find(([name]) => name === zone)?.[1] ?? [], cell);
}

const diamondOf = (sim: SurfaceSim): string => {
  const id = Object.keys(sim.entities).find((entity) => entity.startsWith('diamond'));
  if (id === undefined) throw new Error('no diamond');
  return id;
};

/**
 * Hráč jde od startu k diamantu přeloženému na buňku úseku. Kandidáti jsou
 * všechny buňky úseků; vyhoví ten, kde první úsek, na který hráč vkročí, má
 * (`watched`) nebo nemá svou stráž na sobě.
 */
function walkOnto(sim: SurfaceSim, watched: boolean): { sim: SurfaceSim; tick: number; zone: string } {
  const diamond = diamondOf(sim);
  const socket = (sim.entities[diamond] as { socket: string }).socket;
  for (const [, rects] of beats(sim)) {
    for (const [rx, ry, w, h] of rects) {
      for (let x = rx; x < rx + w; x += 1) {
        for (let y = ry; y < ry + h; y += 1) {
          const moved = { ...sim, sockets: { ...sim.sockets, [socket]: [x, y] as Cell } };
          const first = firstStep(moved, diamond);
          if (first === null || first.zones.length !== 1) continue;
          const zone = first.zones[0] as string;
          // Vstup do zóny se vyhodnotí v tiku po kroku; stráž musí sedět v obou.
          if (guardOn(moved, zone, first.tick) === watched && guardOn(moved, zone, first.tick + 1) === watched) return { sim: moved, tick: first.tick, zone };
        }
      }
    }
  }
  throw new Error(`no cell where the player steps onto a ${watched ? 'watched' : 'empty'} stretch`);
}

/** Tik, ve kterém stráž poprvé vkročí na úsek – bez pravidel výhledu, hráč stojí. */
function guardEnters(sim: SurfaceSim, zone: string): number {
  const rects = beats(sim).find(([name]) => name === zone)?.[1] ?? [];
  const frames = play({ ...sim, rules: onlyRules(sim, /^$/) }, []);
  const entry = frames.findIndex((frame, index) => index > 0 && inRects(rects, frame.cells[guardOf(zone)] as Cell) && !inRects(rects, frames[index - 1]?.cells[guardOf(zone)] as Cell));
  if (entry < 0) throw new Error(`guard never enters ${zone}`);
  return frames[entry]?.tick as number;
}

/**
 * Hráč stojí na buňce jediného úseku, který jeho stráž na startu nemá, a
 * čeká. `null` = na buňce žádný úsek není (protipříklad).
 */
function standOn(sim: SurfaceSim, onBeat: boolean): { sim: SurfaceSim; zone: string | null } {
  const idle = play({ ...sim, rules: onlyRules(sim, /^$/) }, [], 1)[0] as Frame;
  const width = (sim.layout as { width: number }).width;
  const height = (sim.layout as { height: number }).height;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const zones = beatsAt(sim, [x, y]);
      const walkable = beats(sim).some(([, rects]) => inRects(rects, [x, y])) || Object.values(sim.sockets).some(([sx, sy]) => sx === x && sy === y);
      if (!walkable) continue;
      if (!onBeat && zones.length === 0) return { sim: { ...sim, sockets: { ...sim.sockets, spawn: [x, y] as Cell } }, zone: null };
      if (!onBeat || zones.length !== 1) continue;
      const zone = zones[0] as string;
      const guardCell = idle.cells[guardOf(zone)] as Cell;
      if (inRects(beats(sim).find(([name]) => name === zone)?.[1] ?? [], guardCell)) continue;
      return { sim: { ...sim, sockets: { ...sim.sockets, spawn: [x, y] as Cell } }, zone };
    }
  }
  throw new Error('no cell to stand on');
}

describe('patrol sight – each rule on its own', () => {
  const sim = stealthSim();

  it('spot: stepping onto the stretch a guard is on loses, stepping onto an empty one does not', () => {
    const spotOnly = { ...sim, rules: onlyRules(sim, /\.spot\d+$/) };

    const watched = walkOnto(spotOnly, true);
    const frames = play(watched.sim, [{ tick: 0, actionId: 'moveTo', target: diamondOf(sim) }]);
    const last = frames.at(-1) as Frame;
    expect(last.runState).toBe('lost');
    expect(last.tick).toBe(watched.tick + 1);
    expect(last.fired).toContain(`patrol.${guardOf(watched.zone)}.spot${watched.zone.replace(/^.*_beat/, '')}`);

    const empty = walkOnto(spotOnly, false);
    const calm = play(empty.sim, [{ tick: 0, actionId: 'moveTo', target: diamondOf(sim) }], empty.tick + 2);
    expect(calm).toHaveLength(empty.tick + 2);
    expect(calm.at(-1)?.runState).toBe('running');
  });

  it('sees: a guard walking onto the stretch where the player stands loses, a player off every stretch is safe', () => {
    const seesOnly = { ...sim, rules: onlyRules(sim, /\.sees\d+$/) };

    const standing = standOn(seesOnly, true);
    const zone = standing.zone as string;
    const frames = play(standing.sim, []);
    const last = frames.at(-1) as Frame;
    expect(last.runState).toBe('lost');
    // Prohra patří kroku stráže, ne hráčovu startu: vstup do zóny se vyhodnotí v tiku po kroku.
    expect(last.tick).toBe(guardEnters(standing.sim, zone) + 1);
    expect(last.fired).toContain(`patrol.${guardOf(zone)}.sees${zone.replace(/^.*_beat/, '')}`);

    const away = standOn(seesOnly, false);
    expect(play(away.sim, []).at(-1)?.runState).toBe('running');
  });
});
