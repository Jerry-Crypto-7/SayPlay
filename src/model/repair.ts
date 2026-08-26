/**
 * Oprava emise před certifikací — **jen to, co nemění význam**.
 *
 * ## Kde je hranice
 *
 * Projekt stojí na jediné dokázané vlastnosti: nic vadného neprojde přijetím.
 * Oprava, která by hádala, co model myslel, by ji shodila — a přesně proto se
 * 21. 8. 2026 zamítlo dohledávání „podobných" jmen (`CLAUDE.md`, rozpor 10).
 * Tenhle modul tu hranici drží tak, že smí **výhradně** tyhle čtyři věci, každou
 * s podmínkou, za které je zásah přesný, ne pravděpodobný:
 *
 * 1. **Zahodit osiřelý vzhledový modul.** `look` je mimo stavový hash a klíč,
 *    který nejmenuje deklarovanou entitu, je dekorace bez vazby. Ztratí se
 *    ozdoba, nezmění se ani jedno pravidlo. Repozitář si tuhle opravu už jednou
 *    schválil sám (`M16 repairable: true`).
 * 2. **`onCollide` mezi entitou a soketem přepsat na `onEnterZone`.** Soket je
 *    pevná buňka a každý soket je zároveň zóna téhož jména; „entita se srazí s
 *    tou buňkou" a „entita vstoupí do té zóny" je v tomhle IR **tatáž
 *    událost**, ne podobná. Podmínka: přesně jedna strana je deklarovaná entita
 *    a druhá je deklarovaný soket nebo zóna, která entitou není.
 * 3. **`stateIs` nad jménem vlajky přepsat na `flagIs`.** Když `target`
 *    nejmenuje žádnou entitu, ale jmenuje deklarovanou vlajku, a hodnota je
 *    boolean, je to záměna kategorie s jediným kanonickým zápisem.
 * 4. **Dohledat svědka.** Vítězná cesta je důkaz, ne obsah — viz
 *    `src/verify/solve.ts`. Model si ji nechává, pokud jeho vlastní projde
 *    ověřením; jinak ji najde systém a ověří **týmž** verifikátorem.
 *
 * Co se **nikdy** nedělá: nedeklaruje se chybějící entita, časovač ani counter
 * (jejich meze a trvání by se musely uhodnout), nepřejmenovává se osiřelý odkaz
 * na „podobný" existující, nedoplňuje se chybějící pravidlo výhry. Takové emise
 * se odmítnou a důvod jde porotci na obrazovku.
 *
 * ## Každý zásah je vidět
 *
 * `notes` jde do verdiktu a odtud do panelu. Vlna 0 zavřela produkt, který
 * tvrdil, že odpovídal model; oprava, o které se mlčí, je tatáž vada znovu.
 */

import { buildRuntimeWorld } from '../ir/build';
import { TIER_POLICY, isTier } from '../verify/tiers';
import { solveWitness } from '../verify/solve';
import { verifyWitness } from '../verify/witness';

/** Jeden zásah, tak jak ho uvidí porotce. Anglicky — je to viditelná měď produktu. */
export interface RepairNote {
  readonly kind: 'lookModuleDropped' | 'collideToZone' | 'stateToFlag' | 'witnessSolved' | 'witnessKept';
  readonly detail: string;
}

export interface RepairResult {
  readonly document: unknown;
  readonly notes: readonly RepairNote[];
}

/**
 * Rozpočet hledání.
 *
 * `maxNodes` je v replayech, ne v čase — hledání musí v prohlížeči i v Node
 * skončit stejně. 20 000 replayů malého světa je řádově desetiny sekundy a
 * proti 40+ sekundám emise je to šum.
 */
const SOLVE_BUDGET = { maxNodes: 20_000, maxDepth: 6, settleTicks: 30 } as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Kopie záznamu bez jednoho klíče. Nesahá na originál — verdikt nese i syrovou emisi. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

interface Declared {
  readonly entities: ReadonlySet<string>;
  readonly sockets: ReadonlySet<string>;
  readonly zones: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
}

function declaredNames(sim: Record<string, unknown>): Declared {
  const state = asRecord(sim.state);
  return {
    entities: new Set(Object.keys(asRecord(sim.entities))),
    sockets: new Set(Object.keys(asRecord(sim.sockets))),
    zones: new Set(Object.keys(asRecord(state.zones))),
    flags: new Set(Object.keys(asRecord(state.flags))),
  };
}

/** Je to jméno místa, a **není** to entita? Jen tehdy je přepis na zónu přesný. */
function placeOnly(name: string, declared: Declared): boolean {
  return !declared.entities.has(name) && (declared.sockets.has(name) || declared.zones.has(name));
}

// ---------------------------------------------------------------------------
// 1. Osiřelý vzhledový modul
// ---------------------------------------------------------------------------

function dropOrphanLookModules(
  look: Record<string, unknown>,
  declared: Declared,
  notes: RepairNote[],
): Record<string, unknown> {
  const modules = asRecord(look.modules);
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(modules)) {
    if (declared.entities.has(key)) kept[key] = value;
    else dropped.push(key);
  }
  if (dropped.length === 0) return look;
  for (const key of dropped)
    notes.push({
      kind: 'lookModuleDropped',
      detail: `look.modules.${key} named no entity, so the system dropped the decoration and kept the world`,
    });
  return { ...look, modules: kept };
}

// ---------------------------------------------------------------------------
// 2. a 3. Přepisy uvnitř jednoho pravidla
// ---------------------------------------------------------------------------

function repairEvent(
  ruleId: string,
  event: Record<string, unknown>,
  declared: Declared,
  notes: RepairNote[],
): Record<string, unknown> {
  if (asString(event.kind) !== 'onCollide') return event;
  const a = asString(event.a);
  const b = asString(event.b);
  if (a === null || b === null) return event;

  const aIsPlace = placeOnly(a, declared);
  const bIsPlace = placeOnly(b, declared);
  // Přesně jedna strana smí být místo. Když jsou místa obě, není kdo vstupuje;
  // když ani jedno, není kam — obojí je vada, kterou tenhle modul neopravuje.
  if (aIsPlace === bIsPlace) return event;

  const entity = aIsPlace ? b : a;
  const zone = aIsPlace ? a : b;
  if (!declared.entities.has(entity)) return event;

  notes.push({
    kind: 'collideToZone',
    detail: `rule ${ruleId}: onCollide(${a}, ${b}) names the place ${zone}, so the system read it as onEnterZone(${entity}, ${zone})`,
  });
  return { ...without(without(event, 'a'), 'b'), kind: 'onEnterZone', entity, zone };
}

function repairCondition(
  ruleId: string,
  condition: unknown,
  declared: Declared,
  notes: RepairNote[],
): unknown {
  if (condition === null || condition === undefined) return condition;
  const node = asRecord(condition);
  const kind = asString(node.kind);

  if (kind === 'allOf' || kind === 'anyOf') {
    const operands = Array.isArray(node.operands) ? node.operands : null;
    if (operands === null) return condition;
    return { ...node, operands: operands.map((operand) => repairCondition(ruleId, operand, declared, notes)) };
  }
  if (kind === 'not') return { ...node, operand: repairCondition(ruleId, node.operand, declared, notes) };

  if (kind !== 'stateIs') return condition;
  const target = asString(node.target) ?? asString(node.entity);
  if (target === null || declared.entities.has(target) || !declared.flags.has(target)) return condition;
  if (typeof node.value !== 'boolean') return condition;

  notes.push({
    kind: 'stateToFlag',
    detail: `rule ${ruleId}: stateIs(${target}) names the flag ${target}, not an entity, so the system read it as flagIs`,
  });
  return { kind: 'flagIs', flag: target, value: node.value };
}

function repairRules(sim: Record<string, unknown>, declared: Declared, notes: RepairNote[]): unknown {
  const rules = asRecord(sim.rules);
  const repaired: Record<string, unknown> = {};
  for (const [ruleId, raw] of Object.entries(rules)) {
    const rule = asRecord(raw);
    repaired[ruleId] = {
      ...rule,
      event: repairEvent(ruleId, asRecord(rule.event), declared, notes),
      condition: repairCondition(ruleId, rule.condition, declared, notes),
    };
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// 4. Svědek
// ---------------------------------------------------------------------------

/**
 * Obálka svědka v tvaru, který systém umí postavit.
 *
 * `H_cert` se dosazuje ze stropu tieru, protože **horizont deklaruje systém**
 * (`VERIFY.md`, `horizonDeclaredBy: "system"`). Není to úleva: strop tieru je
 * přesně to, co by `resolvePolicy` povolila, takže se tím nedá získat ani tik
 * navíc — jen se tím z přání modelu nestane `NO_FIT`.
 */
function witnessEnvelope(sim: Record<string, unknown>): Record<string, unknown> {
  const witness = asRecord(sim.witness);
  const tier = asString(witness.tier);
  const resolved = isTier(tier) ? tier : 'short';
  return {
    ...witness,
    tier: resolved,
    H_cert: TIER_POLICY[resolved].maxHorizonTicks,
    ops: Array.isArray(witness.ops) ? witness.ops : [],
  };
}

function solveFor(sim: Record<string, unknown>, notes: RepairNote[]): Record<string, unknown> {
  const built = buildRuntimeWorld(sim);
  // Svět, který se nedá ani snížit, nemá kde hledat — odmítne ho certifikace a
  // řekne u toho vlastní důvod.
  if (!built.ok) return sim;

  // Vlastní stopa modelu má přednost, když obstojí. Přepsat funkční důkaz svým
  // by bylo tvrzení navíc, ne oprava.
  if (built.world.trace.length > 0) {
    const own = verifyWitness(built.world, built.world.trace);
    if (own.verdict === 'CERTIFIED') {
      notes.push({ kind: 'witnessKept', detail: 'the winning path came from the model and verified as written' });
      return sim;
    }
  }

  const found = solveWitness(built.world, SOLVE_BUDGET);
  if (found === null) return sim;

  notes.push({
    kind: 'witnessSolved',
    detail: `the system searched ${found.nodes} replays and found a winning path of ${found.ops.length} moves, winning at tick ${found.wonAtTick}`,
  });
  const witness = asRecord(sim.witness);
  return {
    ...sim,
    witness: {
      ...witness,
      // `L_witness` je kolik tiků stopa doopravdy potřebovala, a čte ho panel
      // překladu. Dokud ho hledač nepsal, stálo vedle nalezené cesty „win at
      // tick 0" — číslo, které nikdo neměřil, přímo před porotcem.
      L_witness: found.wonAtTick,
      ops: found.ops.map((op) => (op.target === undefined ? { tick: op.tick, actionId: op.actionId } : op)),
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Prožene emisi opravami a vrátí dokument, který se má certifikovat.
 *
 * Vstup se **nemění** — verdikt nese vedle opraveného dokumentu i to, co model
 * doopravdy napsal.
 */
export function repairEmission(body: unknown): RepairResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { document: body, notes: [] };
  const document = body as Record<string, unknown>;
  const rawSim = document.sim;
  // `sim: null` je poctivé odmítnutí modelu, ne vada. Neopravuje se.
  if (typeof rawSim !== 'object' || rawSim === null || Array.isArray(rawSim)) return { document: body, notes: [] };

  const sim = rawSim as Record<string, unknown>;
  const declared = declaredNames(sim);
  const notes: RepairNote[] = [];

  const withRules = { ...sim, rules: repairRules(sim, declared, notes), witness: witnessEnvelope(sim) };
  const withWitness = solveFor(withRules, notes);
  const look = dropOrphanLookModules(asRecord(document.look), declared, notes);

  return { document: { ...document, sim: withWitness, look }, notes };
}
