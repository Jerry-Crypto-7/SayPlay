/**
 * `timer`: odpočet, který hru vyhraje, prohraje nebo vyšle signál.
 *
 * Časovač s `init = durationTicks` běží od prvního tiku sám (`settle` ho
 * každý tik sníží, `src/sim/interpreter.ts:805`), takže `onStart → startTimer`
 * není potřeba; `onTimerEnd` je pád hrany `timer > 0`.
 *
 * Fáze (P25D T1, „červená–zelená“) drží dvojice časovačů `<id>_go` a
 * `<id>_stop` jako pulz `hazard_zone`; červenou nese flag `<id>_red`. Runtime
 * nemá událost „hráč se pohnul“, každý krok ale vstoupí do nového sloupce nebo
 * řádku mřížky – sloupce a řádky jsou proto zóny (`<id>_col<x>`, `<id>_row<y>`)
 * a vstup do kterékoli z nich v červené prohraje. Stání na místě nic nespustí.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceAction, SurfaceRule, TimerDecl } from '../types';
import type { Rect } from '../layout';

export const TICKS_PER_SECOND = 20;

type Params = z.infer<(typeof MECHANICS)['timer']['params']>;

/** Flag červené fáze časovače `id`. */
export const redFlag = (id: string): string => `${id}_red`;

export const timer: MechanicAdapter<Params> = (params, ctx) => {
  const ticks = params.seconds * TICKS_PER_SECOND;
  const end = `timer.${params.id}.end`;
  const action: SurfaceAction =
    params.onEnd === 'signal' ? { kind: 'emit', signal: params.signal ?? `${params.id}Ended` } : { kind: params.onEnd };
  const rules: Record<string, SurfaceRule> = {
    [end]: { id: end, phase: 2, priority: 0, event: { kind: 'onTimerEnd', timer: params.id }, condition: null, actions: [action] },
  };
  const timers: Record<string, TimerDecl> = { [params.id]: { durationTicks: ticks, init: ticks } };
  if (params.phases === undefined) return { timers, rules };

  const goTicks = params.phases.goSeconds * TICKS_PER_SECOND;
  const stopTicks = params.phases.stopSeconds * TICKS_PER_SECOND;
  const go = `${params.id}_go`;
  const stop = `${params.id}_stop`;
  const red = redFlag(params.id);
  timers[go] = { durationTicks: goTicks, init: goTicks };
  timers[stop] = { durationTicks: stopTicks, init: 0 };
  const watchers = params.phases.watcher === undefined ? [] : ctx.instances(params.phases.watcher);
  const look = (value: 'away' | 'watching'): SurfaceAction[] => watchers.map((id): SurfaceAction => ({ kind: 'setState', target: id, value }));
  rules[`timer.${params.id}.toRed`] = {
    id: `timer.${params.id}.toRed`,
    phase: 0,
    priority: 0,
    event: { kind: 'onTimerEnd', timer: go },
    condition: null,
    actions: [{ kind: 'setFlag', ref: red, value: true }, ...look('watching'), { kind: 'startTimer', ref: stop }],
  };
  rules[`timer.${params.id}.toGreen`] = {
    id: `timer.${params.id}.toGreen`,
    phase: 0,
    priority: 0,
    event: { kind: 'onTimerEnd', timer: stop },
    condition: null,
    actions: [{ kind: 'setFlag', ref: red, value: false }, ...look('away'), { kind: 'startTimer', ref: go }],
  };

  const zones: Record<string, readonly Rect[]> = {};
  const lanes: string[] = [];
  for (let x = 0; x < ctx.layout.width; x += 1) {
    zones[`${params.id}_col${x}`] = [[x, 0, 1, ctx.layout.height]];
    lanes.push(`${params.id}_col${x}`);
  }
  for (let y = 0; y < ctx.layout.height; y += 1) {
    zones[`${params.id}_row${y}`] = [[0, y, ctx.layout.width, 1]];
    lanes.push(`${params.id}_row${y}`);
  }
  // První tik vidí hráče „vstoupit“ do sloupce i řádku, kde stojí; to krok není.
  // `armed` nastaví `onStart` a stráž ho v témže tiku ještě nevidí.
  const armed = `${params.id}_armed`;
  rules[`timer.${params.id}.arm`] = {
    id: `timer.${params.id}.arm`,
    phase: 0,
    priority: 0,
    event: { kind: 'onStart' },
    condition: null,
    actions: [{ kind: 'setFlag', ref: armed, value: true }],
  };
  for (const lane of lanes) {
    rules[`timer.${params.id}.moved.${lane}`] = {
      id: `timer.${params.id}.moved.${lane}`,
      phase: 1,
      priority: 0,
      event: { kind: 'onEnterZone', entity: ctx.player, zone: lane },
      condition: {
        kind: 'allOf',
        operands: [
          { kind: 'flagIs', ref: red, value: true },
          { kind: 'flagIs', ref: armed, value: true },
        ],
      },
      actions: [{ kind: 'lose' }],
    };
  }
  return {
    timers,
    rules,
    zones,
    flags: { [red]: { init: false }, [armed]: { init: false } },
    witnessWindow: { goTicks, stopTicks },
  };
};
