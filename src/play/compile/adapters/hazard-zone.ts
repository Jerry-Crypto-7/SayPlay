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
 *
 * `pulse.alternate` (P25D T3, pohyblivá zeď): instance 2k a 2k+1 jsou dvě
 * polohy jedné zdi; liché svítí, když sudé ne, takže zeď „přeskakuje“ mezi
 * nimi. Runtime má `blocked` pevné a entity neblokují, proto zeď cestu
 * nezavře – vstup do zapnuté polohy prohraje, jako u každého hazardu.
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
  const alternate = params.pulse?.alternate === true;
  const flip = (index: number, value: 'on' | 'off'): 'on' | 'off' => (alternate && index % 2 === 1 ? (value === 'on' ? 'off' : 'on') : value);

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
      actions: [...instances.map((id, index): SurfaceAction => ({ kind: 'setState', target: id, value: flip(index, 'off') })), { kind: 'startTimer', ref: offTimer }],
    };
    rules[toOn] = {
      id: toOn,
      phase: 0,
      priority: 0,
      event: { kind: 'onTimerEnd', timer: offTimer },
      condition: null,
      actions: [...instances.map((id, index): SurfaceAction => ({ kind: 'setState', target: id, value: flip(index, 'on') })), { kind: 'startTimer', ref: onTimer }],
    };
    if (alternate) {
      // Hazard startuje `on`; liché polohy zdi musí začít vypnuté.
      rules[`hazard_zone.${params.role}.stagger`] = {
        id: `hazard_zone.${params.role}.stagger`,
        phase: 0,
        priority: 0,
        event: { kind: 'onStart' },
        condition: null,
        actions: instances.filter((_, index) => index % 2 === 1).map((id): SurfaceAction => ({ kind: 'setState', target: id, value: 'off' })),
      };
    }
  }

  for (const [index, id] of instances.entries()) {
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
        // Poloha se zapne na konci `off` časovače, lichá poloha střídající zdi na konci `on`.
        event: { kind: 'onTimerEnd', timer: flip(index, 'on') === 'on' ? offTimer : onTimer },
        condition: inside,
        actions: [hit],
      };
    }
  }
  return { rules, timers };
};
