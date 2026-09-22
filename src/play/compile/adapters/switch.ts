/**
 * `switch`: `use` přepíná spínač, správná kombinace odemkne dveře a špatná je
 * zamkne zpět.
 *
 * Stráže se vyhodnocují proti stavu **před** tikem, takže pravidlo dveří nad
 * `onAction(use, sw)` nevidí přepnutí, které týž tik provádí. Kombinace se
 * proto píše „po přepnutí“: člen spínače `sw` je v ní obrácený (žádaný
 * spínač musí být teď `off`, aby byl po přepnutí `on`, a naopak). Čtyři
 * pravidla na spínač: zapnout, vypnout, odemknout, zamknout.
 */

import type { z } from 'zod';

import type { MECHANICS } from '../../registry';
import type { MechanicAdapter, SurfaceAction, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

type Params = z.infer<(typeof MECHANICS)['switch']['params']>;

const stateIs = (target: string, value: string): SurfaceCondition => ({ kind: 'stateIs', target, value });
const flipped = (value: 'on' | 'off'): 'on' | 'off' => (value === 'on' ? 'off' : 'on');

export const switchAdapter: MechanicAdapter<Params> = (params, ctx) => {
  const rules: Record<string, SurfaceRule> = {};
  const wantedByInstance = new Map<string, 'on' | 'off'>();
  for (const role of params.switchRoles) {
    for (const sw of ctx.instances(role)) wantedByInstance.set(sw, params.required.includes(role) ? 'on' : 'off');
  }
  const switches = [...wantedByInstance.keys()];
  const wanted = (sw: string): 'on' | 'off' => wantedByInstance.get(sw) as 'on' | 'off';
  const doors = ctx.instances(params.doorRole);
  const lockDoors = (locked: boolean): SurfaceAction[] => doors.map((door) => ({ kind: 'setLocked', target: door, locked }));

  // Žádané spínače v pořadí `required` – v uspořádané hře v tomto pořadí jdou zapnout.
  const requiredInOrder = [...new Set(params.required)].flatMap((role) => ctx.instances(role));

  for (const sw of switches) {
    const use = { kind: 'onAction', actor: ctx.player, actionId: 'use', target: sw } as const;
    // Kombinace po přepnutí `sw`: ostatní tak, jak mají být; `sw` obráceně.
    const comboAfter: SurfaceCondition = {
      kind: 'allOf',
      operands: switches.map((other) => stateIs(other, other === sw ? flipped(wanted(other)) : wanted(other))),
    };
    const rule = (suffix: string, phase: number, condition: SurfaceCondition, actions: SurfaceAction[]): void => {
      const id = `switch.${sw}.${suffix}`;
      rules[id] = { id, phase, priority: 0, event: use, condition, actions };
    };
    // V pořadí jde žádaný spínač zapnout, jen když všechny před ním svítí;
    // jinak vypne všechny žádané. Dveře zamkne pravidlo `lock` – kombinace
    // po stisku mimo pořadí nikdy nesedí.
    const before = params.ordered === true ? requiredInOrder.slice(0, Math.max(0, requiredInOrder.indexOf(sw))) : [];
    const inOrder: SurfaceCondition = { kind: 'allOf', operands: before.map((prev) => stateIs(prev, 'on')) };
    const setOn: SurfaceAction[] = [{ kind: 'setState', target: sw, value: 'on' }];
    if (before.length === 0) {
      rule('on', 0, stateIs(sw, 'off'), setOn);
    } else {
      rule('on', 0, { kind: 'allOf', operands: [stateIs(sw, 'off'), inOrder] }, setOn);
      rule('wrong', 0, { kind: 'allOf', operands: [stateIs(sw, 'off'), { kind: 'not', operand: inOrder }] }, [
        ...requiredInOrder.map((target): SurfaceAction => ({ kind: 'setState', target, value: 'off' })),
      ]);
    }
    rule('off', 0, stateIs(sw, 'on'), [{ kind: 'setState', target: sw, value: 'off' }]);
    rule('unlock', 1, comboAfter, lockDoors(false));
    rule('lock', 1, { kind: 'not', operand: comboAfter }, lockDoors(true));
  }

  const witnessOrder = params.ordered === true ? requiredInOrder : switches.filter((sw) => wanted(sw) === 'on');
  const witness: WitnessStep[] = witnessOrder.map((sw) => ({ actionId: 'use', target: sw, stage: 0 }));
  return { rules, witness };
};
