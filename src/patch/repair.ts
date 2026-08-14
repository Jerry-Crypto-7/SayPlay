/**
 * Mechanická opravná dávka — **kanonizace, výchozí hodnoty, rozsahy indexů.
 * Žádná dohadovaná sémantika.**
 *
 * Zmrazený `protocol.v1.json` to formuluje jako `malformedFixtures.repairRule`
 * a podlahu klade na 8 z 30 (`repairFloor.minRepaired`). Zmrazená sada z T2
 * deklaruje 15 emisí jako `repairable: true` a u každé nese `mustPreserve` —
 * nezávislou anotaci toho, co oprava změnit **nesmí**. Bez ní by si opravář
 * mohl zvolit vlastní laťku a „opravit" emisi tak, že změní její význam.
 *
 * ## Kde je hranice mezi opravou a hádáním
 *
 * Opravit se smí to, co má **jedinou** odvoditelnou odpověď:
 *
 * - hodnota, kterou deklaruje jiné pole téhož dokumentu (`init` z `min`,
 *   `durationTicks` z tieru svědka),
 * - převod jednotky, který je v protokolu pevný (20 Hz, `tick.hz`),
 * - pořadí kolekce, která existuje jen kvůli serializaci (§7 krok 1),
 * - pole, které **žádný konzument nečte** (neznámé metadatové pole pravidla),
 * - hodnota mimo vlastní deklarované meze (clamp na `max`).
 *
 * Všechno ostatní je odmítnutí se jménem, ne oprava. Zmrazená sada to má
 * v obou polaritách u téže třídy: `type_coercion` je opravitelná u řetězce
 * `"3"` (M07) a neopravitelná u `600.5` (M09), protože zaokrouhlit nahoru
 * i dolů mění délku běhu. `dangling_reference` je neopravitelná u odkazu do
 * `sim` (M15 — meze chybějícího counteru by se musely uhodnout) a opravitelná
 * u osiřelého vzhledového modulu (M16 — `look` je mimo hash). Rozhoduje o tom
 * `findDanglingReferences` z T8b, ne vlastní tabulka.
 *
 * ## Co odsud NEVYPADNE
 *
 * Verdikt o platnosti. Opravář dokument mechanicky srovná a vykáže, co udělal;
 * jestli výsledek projde, rozhoduje **produkční řetěz** (schéma → odkazy →
 * `look` → snížení do IR), ne tenhle modul. Kdyby si platnost soudil sám,
 * měřilo by se jeho vlastní tvrzení.
 *
 * ## Report je úplný, ne ilustrativní
 *
 * Každý krok nese **všechny** pointery, které se jím pohnuly, takže se dá proti
 * `changedLeaves` ověřit, že opravář nezměnil nic, co nevykázal. Jediná výjimka
 * je `order.rules`: pořadí klíčů není list a diff stavu ho nevidí (od
 * `evals-frozen-v2` ho nevidí ani `simHash`, protože `canonical()` klíče řadí)
 * — ta třída se měří jednotkou pořadí klíčů, viz `evals/__tests__/rule-order.ts`.
 */

import { findDanglingReferences } from '../ir/references';
import { canonical, LOOK_FIELDS, type LookPart } from '../ir/worlddoc';
import { TICK_HZ } from '../sim/clock';
import { TIER_POLICY, isTier } from '../verify/tiers';
import { pointerOf } from './reject';

export type RepairRule =
  /** `simRevision` a `lookRevision` nové emise jsou nula — revize vlastní systém. */
  | 'revision.reset'
  /** Chybějící část `look` se doplní systémovým defaultem (v P1 ji emituje systém). */
  | 'look.systemDefault'
  /** Pole vlastněné vzhledem, které leželo v `sim`, se přesune do `look`. */
  | 'look.leakedField'
  /** Vzhledový modul odkazující na `stableId`, který v `sim.entities` není. */
  | 'look.orphanModule'
  /** Metadatové pole pravidla, které nečte žádný konzument. */
  | 'rule.unknownField'
  /** Bezeztrátový celočíselný řetězec v poli, které runtime čte jako celé číslo. */
  | 'number.fromIntegerString'
  /** `durationSeconds` timeru na `durationTicks` při 20 Hz. */
  | 'timer.secondsToTicks'
  /** Timer bez deklarované délky dostane délku z tieru svědka. */
  | 'timer.durationFromTier'
  /** `freeze` v sekundách na tiky při 20 Hz. */
  | 'freeze.secondsToTicks'
  /** Counter bez `init` startuje na svém `min`. */
  | 'counter.initFromMin'
  /** `init` counteru mimo vlastní deklarované meze se clampne. */
  | 'counter.initClamp'
  /** Flag s hodnotou 0/1 místo boolean. */
  | 'flag.booleanInit'
  /** Operandy komutativního operátoru v kanonickém pořadí. */
  | 'order.operands'
  /** Klíče `sim.rules` v pořadí vykonání `(phase, priority, ruleId)`. */
  | 'order.rules';

export type RepairRefusalKind =
  /** Osiřelý odkaz do `sim` — chybějící deklaraci by opravář musel vymyslet. */
  | 'dangling.sim'
  /** Délka timeru, která není kladné celé číslo tiků. */
  | 'timer.fractionalDuration'
  /** `freeze`, jehož sekundy nevyjdou na celý tik. */
  | 'freeze.fractionalTicks'
  /** Counter bez deklarovaných mezí — horní mez je rozhodnutí o stavovém prostoru. */
  | 'counter.unbounded'
  /** Uniklé pole, které už `look` deklaruje — která hodnota platí, je sémantika. */
  | 'look.leakedFieldOccupied';

export interface RepairStep {
  readonly rule: RepairRule;
  /** Všechna místa, která se tímhle krokem pohnula. RFC 6901. */
  readonly pointers: readonly string[];
  readonly detail: string;
}

export interface RepairRefusal {
  readonly kind: RepairRefusalKind;
  /**
   * Místo vady tak, jak ho pojmenoval ten, kdo ji našel: RFC 6901 pointer
   * u vlastních kontrol, cesta resolveru (`sim.rules[win].event.zone`)
   * u osiřelého odkazu. **Není to adresa k aplikaci** — odmítnutí se ničím
   * neaplikuje, a přepisovat cizí cestu na pointer by u klíče s tečkou tiše
   * ukázalo jinam.
   */
  readonly where: string;
  readonly detail: string;
}

export interface RepairReport {
  /** Opravená kopie. Vstup se nikdy nemění. */
  readonly document: unknown;
  readonly applied: readonly RepairStep[];
  readonly refused: readonly RepairRefusal[];
}

/**
 * Systémový default vzhledu — tvar ze zmrazeného korpusu, `modules` **prázdné**.
 *
 * Prázdné schválně: klíč modulu je `stableId` entity (§13.1 to je jediná povolená
 * vazba z `look` do `sim`), takže vymyšlený modul by byl osiřelý odkaz. Fixtura
 * `src/ir/__fixtures__/synth.ts` nese `modules.hero`, protože její svět tu entitu
 * má; default doplňovaný do cizího dokumentu ji mít nemůže.
 */
export function systemDefaultLook(): LookPart {
  return {
    modules: {},
    palette: 'slate',
    lightRig: 'key',
    atmosphere: 'none',
    materialRoles: {},
    camera: { kind: 'orbit' },
    audio: {},
  };
}

/**
 * Pole pravidla, která **někdo čte**: `build.ts` sahá na `phase`, `priority`,
 * `event`, `condition` a `actions`, `worlddoc.ruleKeyFault` na `id`. Cokoli
 * jiného je metadata a odstranit se smí právě proto, že to nemá konzumenta.
 *
 * Naměřeno nad celým zmrazeným korpusem (30 vadných emisí + 40 syntetických
 * odpovědí): jediné takové pole je `M10/win/comment`. Tenhle krok tedy nesahá
 * na žádný jiný zmrazený záznam.
 */
const RULE_FIELDS = new Set(['id', 'phase', 'priority', 'event', 'condition', 'actions']);

/**
 * Pole, která runtime čte jako **celé číslo**, podle `kind` uzlu.
 *
 * Tabulka je opsaná z `ir/surface.ts` a `ir/build.ts` — z toho, kdo hodnotu
 * doopravdy čte přes `asInt`, ne z představy o gramatice. Řetězec v poli, které
 * nikdo jako číslo nečte, se nepřevádí: převod by změnil typ hodnoty, kterou
 * konzument bere jako jméno.
 */
const INTEGER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  onCounterReaches: ['threshold', 'n'],
  counterIs: ['value'],
  countInZone: ['value'],
  addCounter: ['by', 'delta'],
  startTimer: ['durationTicks'],
  moveTo: ['ticks'],
  freeze: ['ticks'],
};

/** Komutativní booleovské operátory a klíče, pod kterými povrch nese operandy. */
const COMMUTATIVE = new Set(['allOf', 'anyOf']);
const OPERAND_KEYS = ['operands', 'of', 'clauses'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Řetězec, který je **bezeztrátově** celým číslem.
 *
 * Kanonický zápis, ne `Number.parseInt`: `"03"`, `" 3"` ani `"3.0"` neprojdou,
 * protože u nich převod mění zápis a opravář by rozhodoval, který z nich autor
 * myslel. `"3"` projde a to je ta třída, kterou M07 mrazí.
 */
function losslessInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

class Draft {
  readonly steps: RepairStep[] = [];
  readonly refusals: RepairRefusal[] = [];

  step(rule: RepairRule, pointers: readonly string[], detail: string): void {
    this.steps.push({ rule, pointers, detail });
  }

  refuse(kind: RepairRefusalKind, where: string, detail: string): void {
    this.refusals.push({ kind, where, detail });
  }
}

/** Celočíselné řetězce v jednom uzlu gramatiky (událost, podmínka, akce). */
function coerceIntegers(node: Record<string, unknown>, at: readonly string[], draft: Draft): void {
  const kind = node.kind;
  const fields = typeof kind === 'string' ? INTEGER_FIELDS[kind] : undefined;
  if (fields === undefined) return;
  for (const field of fields) {
    const parsed = losslessInteger(node[field]);
    if (parsed === null) continue;
    node[field] = parsed;
    draft.step('number.fromIntegerString', [pointerOf([...at, field])], `${field} was the string "${parsed}"`);
  }
}

/** Podmínka je strom; operandy komutativních uzlů se řadí kanonicky (§7 krok 1). */
function repairCondition(value: unknown, at: readonly string[], draft: Draft): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => repairCondition(item, [...at, String(index)], draft));
    return;
  }
  if (!isRecord(value)) return;

  coerceIntegers(value, at, draft);
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child) || Array.isArray(child)) repairCondition(child, [...at, key], draft);
  }

  if (typeof value.kind !== 'string' || !COMMUTATIVE.has(value.kind)) return;
  for (const key of OPERAND_KEYS) {
    const operands = value[key];
    if (!Array.isArray(operands) || operands.length < 2) continue;
    // Klíč řazení je kanonický zápis operandu: je totální, deterministický a
    // nezávisí na pořadí klíčů uvnitř operandu. Množina operandů se jím měnit
    // nemůže — řadí se táž pole, jen jinak seřazená.
    const sorted = [...operands].sort((a, b) => {
      const left = canonical(a);
      const right = canonical(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (sorted.every((item, index) => item === operands[index])) continue;
    value[key] = sorted;
    draft.step('order.operands', [pointerOf([...at, key])], `${value.kind} operands were not in canonical order`);
  }
}

function repairRules(sim: Record<string, unknown>, draft: Draft): void {
  if (!isRecord(sim.rules)) return;

  for (const [key, entry] of Object.entries(sim.rules)) {
    if (!isRecord(entry)) continue;
    const at = ['sim', 'rules', key];

    for (const field of Object.keys(entry)) {
      if (RULE_FIELDS.has(field)) continue;
      delete entry[field];
      draft.step('rule.unknownField', [pointerOf([...at, field])], `no consumer reads rule field ${field}`);
    }

    for (const field of ['phase', 'priority'] as const) {
      const parsed = losslessInteger(entry[field]);
      if (parsed === null) continue;
      entry[field] = parsed;
      draft.step('number.fromIntegerString', [pointerOf([...at, field])], `${field} was the string "${parsed}"`);
    }

    if (isRecord(entry.event)) coerceIntegers(entry.event, [...at, 'event'], draft);
    repairCondition(entry.condition, [...at, 'condition'], draft);

    if (!Array.isArray(entry.actions)) continue;
    entry.actions.forEach((action, index) => {
      if (!isRecord(action)) return;
      const where = [...at, 'actions', String(index)];
      coerceIntegers(action, where, draft);
      repairFreezeUnits(action, where, draft);
    });
  }
}

/**
 * `freeze` počítá v TICÍCH (`grammar.resolvedSemantics.freeze`). Sekundy se
 * převedou při 20 Hz; co nevyjde na celý tik, je odmítnutí — zaokrouhlení
 * v obou směrech mění délku běhu, což je táž vada, jakou mrazí M09.
 */
function repairFreezeUnits(action: Record<string, unknown>, at: readonly string[], draft: Draft): void {
  if (action.kind !== 'freeze' || action.ticks !== undefined) return;
  const seconds = action.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;

  const ticks = seconds * TICK_HZ;
  if (!Number.isInteger(ticks) || ticks < 1) {
    draft.refuse(
      'freeze.fractionalTicks',
      pointerOf([...at, 'seconds']),
      `${seconds} s is ${ticks} ticks at ${TICK_HZ} Hz, and rounding either way changes the freeze`,
    );
    return;
  }
  delete action.seconds;
  action.ticks = ticks;
  draft.step(
    'freeze.secondsToTicks',
    [pointerOf([...at, 'seconds']), pointerOf([...at, 'ticks'])],
    `${seconds} s is ${ticks} ticks at ${TICK_HZ} Hz`,
  );
}

function repairCounters(state: Record<string, unknown>, draft: Draft): void {
  if (!isRecord(state.counters)) return;
  for (const [id, decl] of Object.entries(state.counters)) {
    if (!isRecord(decl)) continue;
    const at = ['sim', 'state', 'counters', id];
    const min = decl.min;
    const max = decl.max;
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      draft.refuse(
        'counter.unbounded',
        pointerOf(at),
        `counter ${id} declares no integer bounds, and inventing one decides the size of the state space`,
      );
      continue;
    }

    if (decl.init === undefined) {
      decl.init = min;
      draft.step('counter.initFromMin', [pointerOf([...at, 'init'])], `counter ${id} starts at its declared min`);
      continue;
    }
    if (!Number.isInteger(decl.init)) continue;

    const clamped = Math.min(Math.max(decl.init as number, min as number), max as number);
    if (clamped === decl.init) continue;
    draft.step(
      'counter.initClamp',
      [pointerOf([...at, 'init'])],
      `counter ${id} started at ${String(decl.init)}, outside its declared bounds`,
    );
    decl.init = clamped;
  }
}

function repairTimers(state: Record<string, unknown>, tier: unknown, draft: Draft): void {
  if (!isRecord(state.timers)) return;
  for (const [id, decl] of Object.entries(state.timers)) {
    if (!isRecord(decl)) continue;
    const at = ['sim', 'state', 'timers', id];

    // Převod jednotky jde PŘED doplněním z tieru: timer, který délku deklaruje
    // v sekundách, ji deklarovanou má, jen v jiné jednotce. Opačné pořadí by mu
    // vnutilo tierový default a deklarovanou délku zahodilo.
    const seconds = decl.durationSeconds;
    if (decl.durationTicks === undefined && typeof seconds === 'number' && Number.isFinite(seconds)) {
      const ticks = seconds * TICK_HZ;
      if (Number.isInteger(ticks) && ticks >= 1) {
        delete decl.durationSeconds;
        decl.durationTicks = ticks;
        draft.step(
          'timer.secondsToTicks',
          [pointerOf([...at, 'durationSeconds']), pointerOf([...at, 'durationTicks'])],
          `timer ${id} declared ${seconds} s, which is ${ticks} ticks at ${TICK_HZ} Hz`,
        );
        continue;
      }
      draft.refuse(
        'timer.fractionalDuration',
        pointerOf([...at, 'durationSeconds']),
        `timer ${id} declares ${seconds} s, which is not a whole number of ticks at ${TICK_HZ} Hz`,
      );
      continue;
    }

    if (decl.durationTicks === undefined) {
      // Délku nese tier svědka, protože ten je jediné číslo v dokumentu, které
      // o délce běhu něco tvrdí — a tvrdí ho systém, ne model.
      if (!isTier(tier)) continue;
      decl.durationTicks = TIER_POLICY[tier].maxHorizonTicks;
      draft.step(
        'timer.durationFromTier',
        [pointerOf([...at, 'durationTicks'])],
        `timer ${id} took the ${tier} tier horizon of ${TIER_POLICY[tier].maxHorizonTicks} ticks`,
      );
      continue;
    }

    if (!Number.isInteger(decl.durationTicks) || (decl.durationTicks as number) < 1) {
      draft.refuse(
        'timer.fractionalDuration',
        pointerOf([...at, 'durationTicks']),
        `timer ${id} declares ${String(decl.durationTicks)} ticks, and a tick is indivisible`,
      );
    }
  }
}

function repairFlags(state: Record<string, unknown>, draft: Draft): void {
  if (!isRecord(state.flags)) return;
  for (const [id, decl] of Object.entries(state.flags)) {
    if (!isRecord(decl)) continue;
    if (decl.init !== 0 && decl.init !== 1) continue;
    const at = ['sim', 'state', 'flags', id, 'init'];
    draft.step('flag.booleanInit', [pointerOf(at)], `flag ${id} carried ${String(decl.init)} instead of a boolean`);
    decl.init = decl.init === 1;
  }
}

/**
 * Pole vlastněné vzhledem, které leželo v `sim`.
 *
 * Uvnitř hashe by rozhodovalo o dosažitelnosti výhry, což je přesně to, čemu
 * dvoudílný dokument brání (§13.1). Přesun hodnotu nemění. Když už `look` totéž
 * pole deklaruje, opravář se stáhne: která z hodnot platí, je sémantika.
 */
function repairLeakedFields(doc: Record<string, unknown>, sim: Record<string, unknown>, draft: Draft): void {
  if (!isRecord(doc.look)) return;
  const look = doc.look;
  for (const field of LOOK_FIELDS) {
    if (!(field in sim)) continue;
    if (field in look) {
      draft.refuse(
        'look.leakedFieldOccupied',
        pointerOf(['sim', field]),
        `look already declares ${field}, so which of the two values holds is a semantic question`,
      );
      continue;
    }
    look[field] = sim[field];
    delete sim[field];
    draft.step(
      'look.leakedField',
      [pointerOf(['sim', field]), pointerOf(['look', field])],
      `${field} belongs to look and inside the hash it could decide reachability`,
    );
  }
}

/**
 * Osiřelé odkazy — rozhoduje `findDanglingReferences` (T8b), ne vlastní tabulka.
 *
 * Nález ve vzhledovém modulu je opravitelný smazáním: `look` je mimo hash, takže
 * odstranění nemůže změnit sémantiku `sim`. Nález kdekoli v `sim` opravitelný
 * není — chybějící deklarace nese meze i počáteční hodnotu a obojí by se muselo
 * uhodnout.
 */
function repairDanglingReferences(doc: Record<string, unknown>, draft: Draft): void {
  const modules = isRecord(doc.look) && isRecord(doc.look.modules) ? doc.look.modules : null;
  for (const found of findDanglingReferences(doc)) {
    if (modules !== null && found.where === `look.modules.${found.name}` && found.name in modules) {
      delete modules[found.name];
      draft.step(
        'look.orphanModule',
        [pointerOf(['look', 'modules', found.name])],
        `look module ${found.name} names no entity, and look is outside the hash`,
      );
      continue;
    }
    draft.refuse(
      'dangling.sim',
      found.where,
      `${found.where} names no declared ${found.namespace} ${found.name}`,
    );
  }
}

/**
 * Pořadí klíčů `sim.rules` je pořadí vykonání `(phase, priority, ruleId)`.
 *
 * Běží **jako poslední**: pořadí se počítá z `phase` a `priority`, a ty mohla
 * předchozí oprava (celočíselný řetězec) teprve srovnat. Bez konečných řadicích
 * polí se nekoná nic — pořadí je z nich odvozené, takže bez nich není co odvodit.
 */
function repairRuleOrder(sim: Record<string, unknown>, draft: Draft): void {
  if (!isRecord(sim.rules)) return;
  const entries = Object.entries(sim.rules);
  if (entries.length < 2) return;
  if (!entries.every(([, rule]) => isRecord(rule) && Number.isFinite(rule.phase) && Number.isFinite(rule.priority)))
    return;

  const ordered = [...entries].sort(([keyA, a], [keyB, b]) => {
    const ruleA = a as Record<string, number>;
    const ruleB = b as Record<string, number>;
    if (ruleA.phase !== ruleB.phase) return ruleA.phase - ruleB.phase;
    if (ruleA.priority !== ruleB.priority) return ruleA.priority - ruleB.priority;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  if (ordered.every(([key], index) => key === entries[index][0])) return;

  sim.rules = Object.fromEntries(ordered);
  draft.step(
    'order.rules',
    [pointerOf(['sim', 'rules'])],
    `keys were not in execution order (${ordered.map(([key]) => key).join(', ')})`,
  );
}

/**
 * Mechanicky opraví emisi. **Čistá funkce** — vstup se nemění, dva běhy nad týmž
 * vstupem dají bitově týž výsledek (nečte hodiny, náhodu ani prostředí).
 */
export function repairEmission(body: unknown): RepairReport {
  if (!isRecord(body)) return { document: body, applied: [], refused: [] };

  const doc = structuredClone(body);
  const draft = new Draft();

  // Revize vlastní systém, ne model: čerstvá emise začíná na nule a obě pole
  // jsou nezávislá (§13.1.1), takže se srovnávají zvlášť a nikdy se neslučují.
  for (const field of ['simRevision', 'lookRevision'] as const) {
    if (doc[field] === 0) continue;
    doc[field] = 0;
    draft.step('revision.reset', [pointerOf([field])], `${field} of a fresh emission is zero`);
  }

  if (doc.look === undefined) {
    doc.look = systemDefaultLook();
    draft.step('look.systemDefault', [pointerOf(['look'])], 'in P1 the look part is emitted by the system');
  }

  if (isRecord(doc.sim)) {
    const sim = doc.sim;
    repairLeakedFields(doc, sim, draft);
    repairRules(sim, draft);
    if (isRecord(sim.state)) {
      repairCounters(sim.state, draft);
      repairTimers(sim.state, isRecord(sim.witness) ? sim.witness.tier : undefined, draft);
      repairFlags(sim.state, draft);
    }
    repairRuleOrder(sim, draft);
  }

  repairDanglingReferences(doc, draft);

  return { document: doc, applied: draft.steps, refused: draft.refusals };
}
