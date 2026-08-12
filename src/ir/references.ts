/**
 * Rozpouštění jmen v **povrchovém** dokumentu, ještě před snížením do IR.
 *
 * `validateIrDoc` rozpouští jen to, co `world-ir-v1` deklaruje. Emise modelu je
 * ale pořád povrchový `WorldDoc` — countery, sockety a zóny v něm nesou jména,
 * která se do IR vůbec nedostanou, takže osiřelý odkaz je potřeba odhalit dřív,
 * než se cokoli sníží. Z téhle funkce čerpá i mechanická oprava (T15): odkaz na
 * nedeklarovaný counter je neopravitelný, protože jeho meze i počáteční hodnotu
 * by musela uhodnout.
 *
 * Je to **vlastní modul, ne součást `lower.ts`**, a je to záměr: cesta snížení
 * do IR nesmí umět pojmenovat vzhledovou část dokumentu, zatímco tenhle
 * resolver ji pojmenovat musí — kontroluje jedinou vazbu, kterou §13.1 povoluje
 * (`stableId`), a čte přitom výhradně **klíče** `look.modules`, nikdy parametr
 * rodiny, paletu ani kameru.
 *
 * Tabulky níž jsou psané podle povrchového slovníku z `DESIGN-BOOK.md` §5.
 * Jméno pod klíčem, který v tabulce není, se nerozpouští — chybějící řádek je
 * mezera v pokrytí, ne tiché schválení.
 */

export type SurfaceNamespace = 'entity' | 'socket' | 'counter' | 'flag' | 'timer' | 'slot' | 'entityOrSocket';

export interface DanglingReference {
  readonly where: string;
  readonly namespace: SurfaceNamespace;
  readonly name: string;
}

type ReferenceTable = Readonly<Record<string, Readonly<Record<string, SurfaceNamespace>>>>;

const EVENT_REFERENCES: ReferenceTable = {
  onStart: {},
  onClick: { entity: 'entity' },
  onEnterZone: { entity: 'entity', zone: 'socket' },
  onExitZone: { entity: 'entity', zone: 'socket' },
  onCollide: { a: 'entity', b: 'entity' },
  onPickup: { entity: 'entity', slot: 'slot' },
  onDrop: { socket: 'socket', slot: 'slot' },
  onTimerEnd: { timer: 'timer', ref: 'timer' },
  onCounterReaches: { ref: 'counter' },
  onStateEnter: { entity: 'entity', target: 'entity' },
  onSignal: {},
  onSeen: { agent: 'entity', target: 'entity' },
  onAction: { actor: 'entity', target: 'entityOrSocket' },
  onCommandComplete: { entity: 'entity' },
};

const CONDITION_REFERENCES: ReferenceTable = {
  counterIs: { ref: 'counter' },
  flagIs: { ref: 'flag' },
  timerRunning: { ref: 'timer' },
  stateIs: { target: 'entity', entity: 'entity' },
  inZone: { entity: 'entity', zone: 'socket' },
  hasItem: { slot: 'slot' },
  countInZone: { zone: 'socket' },
};

const ACTION_REFERENCES: ReferenceTable = {
  setState: { target: 'entity' },
  setLocked: { target: 'entity' },
  setFlag: { ref: 'flag' },
  addCounter: { ref: 'counter' },
  startTimer: { ref: 'timer' },
  stopTimer: { ref: 'timer' },
  // `spawn` tu záměrně není. Ve zmrazené sadě nese jeho `socket` i selektor
  // (`"random"`), ne jen jméno socketu — rozhodnout, které hodnoty jsou
  // selektory a které jména, patří layoutovému validátoru (P5 T505).
  despawn: { target: 'entity' },
  moveTo: { target: 'entity', socket: 'socket' },
  freeze: { target: 'entity' },
  giveItem: { slot: 'slot' },
  takeItem: { slot: 'slot' },
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function findDanglingReferences(worldDoc: unknown): DanglingReference[] {
  const root = asRecord(worldDoc);
  const sim = asRecord(root.sim);
  // Dokument bez simulace nemá proti čemu odkazy rozpouštět. Není to výjimka
  // ani díra: `NO_FIT` se podle protokolu vztahuje VÝHRADNĚ na `sim`, takže
  // emise bez něj legitimně nese jen vzhledovou část a chybějící `sim` je
  // porušení schématu, ne osiřelý odkaz.
  if (Object.keys(sim).length === 0) return [];
  const state = asRecord(sim.state);

  const entities = new Set(Object.keys(asRecord(sim.entities)));
  const sockets = new Set([...Object.keys(asRecord(sim.sockets)), ...Object.keys(asRecord(state.zones))]);
  const declared: Readonly<Record<SurfaceNamespace, ReadonlySet<string>>> = {
    entity: entities,
    socket: sockets,
    counter: new Set(Object.keys(asRecord(state.counters))),
    flag: new Set(Object.keys(asRecord(state.flags))),
    timer: new Set(Object.keys(asRecord(state.timers))),
    slot: new Set(Object.keys(asRecord(state.slots))),
    entityOrSocket: new Set([...entities, ...sockets]),
  };

  const found: DanglingReference[] = [];
  const resolve = (namespace: SurfaceNamespace, name: unknown, where: string) => {
    if (typeof name !== 'string' || declared[namespace].has(name)) return;
    found.push({ where, namespace, name });
  };
  const applyTable = (table: ReferenceTable, node: Record<string, unknown>, where: string) => {
    const fields = table[String(node.kind)];
    if (!fields) return;
    for (const [field, namespace] of Object.entries(fields)) {
      if (field in node) resolve(namespace, node[field], `${where}.${field}`);
    }
  };
  const walkCondition = (value: unknown, where: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkCondition(item, `${where}[${index}]`));
      return;
    }
    const node = asRecord(value);
    if (Object.keys(node).length === 0) return;
    applyTable(CONDITION_REFERENCES, node, where);
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'object' && child !== null) walkCondition(child, `${where}.${key}`);
    }
  };

  asArray(sim.rules).forEach((entry, index) => {
    const rule = asRecord(entry);
    const where = `sim.rules[${typeof rule.id === 'string' ? rule.id : index}]`;
    applyTable(EVENT_REFERENCES, asRecord(rule.event), `${where}.event`);
    walkCondition(rule.condition, `${where}.condition`);
    asArray(rule.actions).forEach((action, position) => {
      applyTable(ACTION_REFERENCES, asRecord(action), `${where}.actions[${position}]`);
    });
  });

  asArray(asRecord(sim.witness).ops).forEach((entry, index) => {
    resolve('entityOrSocket', asRecord(entry).target, `sim.witness.ops[${index}].target`);
  });

  // Jediná povolená vazba z části vzhledu do simulace (§13.1). Čtou se klíče,
  // tedy `stableId`, nikdy hodnoty modulů.
  for (const stableId of Object.keys(asRecord(asRecord(root.look).modules))) {
    resolve('entity', stableId, `look.modules.${stableId}`);
  }

  return found;
}
