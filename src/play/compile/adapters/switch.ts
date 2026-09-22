/**
 * `switch`: `use` přepíná spínač, správná kombinace odemkne dveře a špatná je
 * zamkne zpět.
 *
 * Stráže se vyhodnocují proti stavu **před** tikem, takže pravidlo dveří nad
 * `onAction(use, sw)` nevidí přepnutí, které týž tik provádí. Kombinace se
 * proto píše „po přepnutí“: člen spínače `sw` je v ní obrácený (žádaný
 * spínač musí být teď `off`, aby byl po přepnutí `on`, a naopak). Čtyři
 * pravidla na spínač: zapnout, vypnout, odemknout, zamknout.
 *
 * S `crateRole` (P25B T4) je žádaný spínač deska: dostane bednu a zapne se,
 * když na něj bedna dojede. Cesta bedny x-pak-y se dělí na nejvýš
 * `PUSH_STEPS` úseků, konec každého je soket `<bedna>_push<k>` (a tím zóna
 * 1×1); `use` na bednu ji pošle na další soket, čítač `<bedna>_at` drží, kolik
 * úseků ujela. Deska bez bedny zůstává tlačítkem.
 */

import type { z } from 'zod';

import { PUSH_STEPS, type MECHANICS } from '../../registry';
import type { Cell } from '../layout';
import type { CounterDecl, MechanicAdapter, SurfaceAction, SurfaceCondition, SurfaceRule, WitnessStep } from '../types';

type Params = z.infer<(typeof MECHANICS)['switch']['params']>;

const stateIs = (target: string, value: string): SurfaceCondition => ({ kind: 'stateIs', target, value });
const flipped = (value: 'on' | 'off'): 'on' | 'off' => (value === 'on' ? 'off' : 'on');

/** Buňky pohybu z `a` do `b` bez `a`: nejdřív po x, pak po y (`stepToward` runtimu). */
function pathCells(a: Cell, b: Cell): Cell[] {
  const cells: Cell[] = [];
  let [x, y] = a;
  while (x !== b[0]) {
    x += Math.sign(b[0] - x);
    cells.push([x, y]);
  }
  while (y !== b[1]) {
    y += Math.sign(b[1] - y);
    cells.push([x, y]);
  }
  return cells;
}

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

  // Bedny: i-tá žádaná deska dostane i-tou bednu.
  const crates = params.crateRole === undefined ? [] : ctx.instances(params.crateRole);
  const crateOf = new Map(requiredInOrder.slice(0, crates.length).map((plate, index) => [plate, crates[index]] as const));
  const sockets: Record<string, Cell> = {};
  const counters: Record<string, CounterDecl> = {};
  const crateWitness: WitnessStep[] = [];
  for (const [plate, crate] of crateOf) {
    const path = pathCells(ctx.layout.cells.get(crate) as Cell, ctx.layout.cells.get(plate) as Cell);
    const steps = Math.min(PUSH_STEPS, path.length);
    const at = `${crate}_at`;
    counters[at] = { min: 0, max: steps, init: 0 };
    const push = { kind: 'onAction', actor: ctx.player, actionId: 'use', target: crate } as const;
    for (let k = 1; k <= steps; k += 1) {
      const socket = `${crate}_push${k}`;
      sockets[socket] = path[Math.ceil((k * path.length) / steps) - 1];
      const id = `switch.${crate}.push${k}`;
      rules[id] = {
        id,
        phase: 0,
        priority: 0,
        event: push,
        condition: { kind: 'counterIs', ref: at, op: '=', value: k - 1 },
        actions: [
          { kind: 'moveTo', target: crate, socket, ticks: 1 },
          { kind: 'addCounter', ref: at, by: 1 },
        ],
      };
      crateWitness.push({ actionId: 'use', target: crate, stage: 0 });
    }
    // Svědek dává mezi kroky jen 2 tiky, bedna jede buňku za tik. Další `use`
    // po posledním posunu nic nedělá (čítač je na maximu) – jen počká, než
    // bedna dojede, jinak by hráč vešel do ještě zamčených dveří a hranu
    // `onEnterZone` promeškal.
    for (let wait = 0; wait < Math.ceil((path.length + 3) / 2); wait += 1) crateWitness.push({ actionId: 'use', target: crate, stage: 0 });
    // Příjezd na desku ji zapne; dveře se otevřou, když ostatní spínače už sedí.
    const arrive = { kind: 'onEnterZone', entity: crate, zone: `${crate}_push${steps}` } as const;
    const others: SurfaceCondition = { kind: 'allOf', operands: switches.filter((other) => other !== plate).map((other) => stateIs(other, wanted(other))) };
    rules[`switch.${plate}.pressed`] = { id: `switch.${plate}.pressed`, phase: 0, priority: 0, event: arrive, condition: null, actions: [{ kind: 'setState', target: plate, value: 'on' }] };
    rules[`switch.${plate}.crate_unlock`] = { id: `switch.${plate}.crate_unlock`, phase: 1, priority: 0, event: arrive, condition: others, actions: lockDoors(false) };
  }

  for (const sw of switches.filter((candidate) => !crateOf.has(candidate))) {
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
  const witness: WitnessStep[] = [
    ...crateWitness,
    ...witnessOrder.filter((sw) => !crateOf.has(sw)).map((sw): WitnessStep => ({ actionId: 'use', target: sw, stage: 0 })),
  ];
  return { rules, witness, sockets, counters };
};
