/**
 * Výhled stráže (P25E T3): úseky, po kterých hlídka „vidí“, jak je zapsal
 * kompilátor – zóny `<stráž>_beat<i>` v `sim.state.zones` (adaptér `patrol`
 * se `sight`). Nic se nedopočítává: co tu není, hra nehlídá.
 *
 * Pole `sim` jsou ve schématu blueprintu `unknown`, proto se tvar čte tady,
 * stejně jako svědek v `PlayShell`.
 */

export type SightRect = readonly [number, number, number, number];

export interface SightBeat {
  readonly guard: string;
  readonly zone: string;
  readonly rects: readonly SightRect[];
}

export interface Sight {
  readonly grid: { readonly width: number; readonly height: number };
  readonly beats: readonly SightBeat[];
}

const BEAT = /^(.+)_beat\d+$/;

interface RawSim {
  readonly layout: unknown;
  readonly entities: unknown;
  readonly state: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isRect = (value: unknown): value is SightRect => Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number');

/** Rozměr mřížky ze `sim.layout`; ten převádí buňku na svět (`cellToWorld`). */
export function gridOf(sim: { readonly layout: unknown }): Sight['grid'] {
  const layout = isRecord(sim.layout) ? sim.layout : {};
  return { width: Number(layout.width) || 0, height: Number(layout.height) || 0 };
}

/** Úseky výhledu všech stráží a rozměr mřížky; hra bez plížení dá `beats: []`. */
export function readSight(sim: RawSim): Sight {
  const grid = gridOf(sim);
  const entities = isRecord(sim.entities) ? sim.entities : {};
  const zones = isRecord(sim.state) && isRecord(sim.state.zones) ? sim.state.zones : {};
  const beats: SightBeat[] = [];
  for (const [zone, rects] of Object.entries(zones)) {
    const guard = BEAT.exec(zone)?.[1];
    if (guard === undefined || !(guard in entities) || !Array.isArray(rects)) continue;
    beats.push({ guard, zone, rects: rects.filter(isRect) });
  }
  return { grid, beats };
}

/** Leží buňka v některém obdélníku úseku? Tak kompilátor soudí `inZone`. */
export function onBeat(beat: SightBeat, x: number, y: number): boolean {
  return beat.rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h);
}
