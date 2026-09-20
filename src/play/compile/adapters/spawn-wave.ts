/**
 * `spawn_wave`: z ohraničeného poolu role se každých `everySeconds` oživí
 * jeden despawnutý člen, dokud jich v aréně není `maxAlive`.
 *
 * Runtime nezná „neaktivní od startu“ (`active` začíná 1 pro každou entitu,
 * `src/sim/interpreter.ts:316`) a `despawn` není v capabilities – vlna proto
 * neoživuje nové, ale ty, které jiná mechanika (`defeat`) odstranila. Členy
 * poolu určuje prefix jména (`buildTags`, `src/ir/build.ts:96`), takže pool se
 * jmenuje jako role a jeho instance `<role>_N` do něj padají samy. Oživený
 * člen se objeví v hnízdě `<role>_nest` (soket ze seedu mimo obsazené buňky);
 * `countInZone` počítá nad **jedním** obdélníkem, aréna je proto celá mřížka.
 * Tři pravidla: start časovače, jeho opakování a oživení se stráží.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceRule } from '../types';
import { TICKS_PER_SECOND } from './timer';

type Params = z.infer<(typeof MECHANICS)['spawn_wave']['params']>;

export const spawnWave: MechanicAdapter<Params> = (params, ctx) => {
  const { width, height, cells } = ctx.layout;
  const used = new Set([...cells.values()].map(([x, y]) => `${x},${y}`));
  let nest: readonly [number, number] = [ctx.rng.int(0, width - 1), ctx.rng.int(0, height - 1)];
  while (used.has(`${nest[0]},${nest[1]}`)) nest = [ctx.rng.int(0, width - 1), ctx.rng.int(0, height - 1)];

  const timerId = `${params.role}_wave`;
  const arena = `${params.role}_arena`;
  const nestSocket = `${params.role}_nest`;
  const ticks = params.everySeconds * TICKS_PER_SECOND;
  const rules: Record<string, SurfaceRule> = {
    [`spawn_wave.${params.role}.start`]: {
      id: `spawn_wave.${params.role}.start`,
      phase: 0,
      priority: 0,
      event: { kind: 'onStart' },
      condition: null,
      actions: [{ kind: 'startTimer', ref: timerId }],
    },
    [`spawn_wave.${params.role}.repeat`]: {
      id: `spawn_wave.${params.role}.repeat`,
      phase: 0,
      priority: 0,
      event: { kind: 'onTimerEnd', timer: timerId },
      condition: null,
      actions: [{ kind: 'startTimer', ref: timerId }],
    },
    [`spawn_wave.${params.role}.spawn`]: {
      id: `spawn_wave.${params.role}.spawn`,
      phase: 1,
      priority: 0,
      event: { kind: 'onTimerEnd', timer: timerId },
      condition: { kind: 'countInZone', zone: arena, tag: params.role, op: '<', value: params.maxAlive },
      actions: [{ kind: 'spawn', poolTag: params.role, socket: nestSocket }],
    },
  };
  return {
    rules,
    sockets: { [nestSocket]: nest },
    timers: { [timerId]: { durationTicks: ticks, init: 0 } },
    zones: { [arena]: [[0, 0, width, height]] },
    pool: { [params.role]: { size: params.poolSize, tag: params.role } },
  };
};
