/**
 * `hazard_zone`: stání v zóně role prohraje nebo zraní; s `pulse` se zóna
 * střídavě zapíná a vypíná.
 *
 * Pulz drží dvojice časovačů na roli (`<role>_on`, `<role>_off`), každý po
 * doběhnutí přepne stav všech instancí a nastartuje ten druhý. Tři pravidla
 * na instanci, protože `onEnterZone` je hrana a mine dva případy: hráče, pod
 * kterým se zóna zapne (`catch`, na konci `off` časovače se stráží `inZone`),
 * a hráče, který v zapnuté zóně už při startu stojí (`start`, pro `placeAt`
 * keypointů). `damage` bez mechaniky `health` ve specu padá na `lose`, aby
 * pravidlo neodkazovalo na čítač, který nikdo nedeklaroval.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceAction, SurfaceRule, TimerDecl } from '../types';
import { DAMAGE_COUNTER } from './health';
import { TICKS_PER_SECOND } from './timer';

type Params = z.infer<(typeof MECHANICS)['hazard_zone']['params']>;

export const hazardZone: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const timers: Record<string, TimerDecl> = {};
  const instances = ctx.instances(params.role);
  const hasHealth = ctx.spec.mechanics.some((mechanic) => mechanic.id === 'health');
  const hit: SurfaceAction = params.effect === 'damage' && hasHealth ? { kind: 'addCounter', ref: DAMAGE_COUNTER, by: 1 } : { kind: 'lose' };
  const onTimer = `${params.role}_on`;
  const offTimer = `${params.role}_off`;

  if (params.pulse !== undefined) {
    const onTicks = params.pulse.onSeconds * TICKS_PER_SECOND;
    const offTicks = params.pulse.offSeconds * TICKS_PER_SECOND;
    timers[onTimer] = { durationTicks: onTicks, init: onTicks };
    timers[offTimer] = { durationTicks: offTicks, init: 0 };
    const toOff = `hazard_zone.${params.role}.toOff`;
    const toOn = `hazard_zone.${params.role}.toOn`;
    rules[toOff] = {
      id: toOff,
      phase: 0,
      priority: 0,
      event: { kind: 'onTimerEnd', timer: onTimer },
      condition: null,
      actions: [...instances.map((id): SurfaceAction => ({ kind: 'setState', target: id, value: 'off' })), { kind: 'startTimer', ref: offTimer }],
    };
    rules[toOn] = {
      id: toOn,
      phase: 0,
      priority: 0,
      event: { kind: 'onTimerEnd', timer: offTimer },
      condition: null,
      actions: [...instances.map((id): SurfaceAction => ({ kind: 'setState', target: id, value: 'on' })), { kind: 'startTimer', ref: onTimer }],
    };
  }

  for (const id of instances) {
    const active = { kind: 'stateIs', target: id, value: 'on' };
    const inside = { kind: 'inZone', entity: ctx.player, zone: id };
    rules[`hazard_zone.${id}.enter`] = {
      id: `hazard_zone.${id}.enter`,
      phase: 1,
      priority: 0,
      event: { kind: 'onEnterZone', entity: ctx.player, zone: id },
      condition: active,
      actions: [hit],
    };
    rules[`hazard_zone.${id}.start`] = {
      id: `hazard_zone.${id}.start`,
      phase: 1,
      priority: 0,
      event: { kind: 'onStart' },
      condition: { kind: 'allOf', operands: [active, inside] },
      actions: [hit],
    };
    if (params.pulse !== undefined) {
      rules[`hazard_zone.${id}.catch`] = {
        id: `hazard_zone.${id}.catch`,
        phase: 1,
        priority: 0,
        event: { kind: 'onTimerEnd', timer: offTimer },
        condition: inside,
        actions: [hit],
      };
    }
  }
  return { rules, timers };
};
