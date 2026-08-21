/**
 * Mysli postav: model je napíše, interpret je běží (P11 T18).
 *
 * ## Model nepíše control flow — ani tady
 *
 * `sim.state.agents` je **deklarace**, ne program: `{ id, disposition, goals }`.
 * Tenhle soubor ji snižuje na dvě věci, které `world-ir-v1` uměl už předtím —
 * na **paměťové sloty** a na **pravidla událost/stráž/akce**. Nevzniká žádné
 * nové primitivum tiku, žádný nový uzel stavu a nic, co by tik uměl jinak než
 * dnes. Interpret o myslích neví a vědět nemá; běží pravidla, jako běží každá
 * jiná. Proto v `src/sim/` není a nebude jediné dynamické vyhodnocení kódu —
 * hlídá to AC úlohy T18 grepem nad celým adresářem.
 *
 * ## Proč mysl bydlí ve `state`, a ne vedle něj
 *
 * `evals/frozen/protocol.v1.json` mrazí kořenová pole `sim` s
 * `additionalPropertiesAllowed: false`, takže `sim.agents` by byl **rozpor se
 * zmrazeným protokolem**, ne rozšíření. Týž protokol přitom u `state` píše
 * doslova *„countery, flagy, timery, entity.state enumy, inventární sloty,
 * memory sloty — vše ohraničené"*. Paměť je stav, mysl je paměť, takže
 * `sim.state.agents` je místo, které protokol pro tuhle věc už měl.
 *
 * ## Co drží povahu naživu
 *
 * Povaha se **nezapéká do pravidel**. Pro každou hodnotu z `AGENT_DISPOSITIONS`
 * vzniká vlastní pravidlo, které se na povahu ptá stráží nad `memory[mood]`.
 * Chování tak rozhoduje **stav**, ne tvar dokumentu: kdyby povahu přepsalo
 * pravidlo, změní se trasa okamžitě a bez přestavby světa.
 *
 * **Za běhu ji dnes přepsat nejde a tenhle soubor to netvrdí.** Povaha vstupuje
 * do slotu jako `initial`, žádné pravidlo do slotu nepíše, a přepočet budoucnosti
 * z T17 změnu `initial` odmítá (`sameLayout` v `src/sim/rebranch.ts`, hláška
 * `changed its initial value`) — je to změna tiku nula, a z tiku 40 se do ní
 * odbočit nedá. Stráže tu tedy platí za **připravenost**, ne za hotovou
 * schopnost. Naměřeno nezávislým posudkem nad T18, 21. 8. 2026.
 *
 * Druhá stráž, nad `memory[goal]`, není kosmetika ani obrana proti nemožnému:
 * zastávky trasy leží ve stejné řadě, takže postava jdoucí ze zastávky 0 na
 * zastávku 2 **prochází zastávkou 1**. Bez té stráže by ji průchozí zóna
 * přesměrovala a trasa by se rozpadla u všech tří povah.
 */

import {
  AGENT_DISPOSITIONS,
  AGENT_GOAL_INDEX,
  AGENT_MEMORY_SLOTS,
  AGENT_MOOD_INDEX,
  MAX_AGENT_GOALS,
  SYMBOL_PATTERN,
  nextGoalIndex,
  type AgentDisposition,
  type AgentMind,
} from '../ir/types';
import { factKey } from '../ir/eval';
import { lowerEvent, predicateIdFor, type SurfaceEventSpec } from '../ir/lower';
import { asArray, asRecord, asString, type Builder, type World } from '../ir/surface';
import { createRuntime, step, type WorldDocRuntime } from './interpreter';

/**
 * Fáze, ve které běží pohyb postav.
 *
 * Za výhrou i prohrou, které zmrazený korpus i rozpoznávač tvarů dávají do fáze
 * 2. Postava se tím nemůže vklínit mezi splnění podmínky výhry a její vyhodnocení
 * — tik, ve kterém hráč vyhrál, vyhraje bez ohledu na to, kam zrovna kdo šel.
 */
const AGENT_PHASE = 3;

function isDisposition(value: string | null): value is AgentDisposition {
  return value !== null && (AGENT_DISPOSITIONS as readonly string[]).includes(value);
}

/** Sloty jedné mysli. Adresují se `agent#index`, ne `id` — `id` je jen jméno. */
function moodSlotId(agent: string): string {
  return `mind.${agent}.mood`;
}

function goalSlotId(agent: string): string {
  return `mind.${agent}.goal`;
}

/**
 * Přečte a **ověří** jednu mysl. Vrací `null`, kdykoli se čtení nepovede — nález
 * jde do `builder`, takže se dokument odmítne jako `UNSUPPORTED_SURFACE` místo
 * aby tiše vznikla postava, která nikam nejde.
 */
function readMind(
  raw: unknown,
  world: World,
  sockets: Readonly<Record<string, readonly [number, number]>>,
  builder: Builder,
  where: string,
): AgentMind | null {
  const decl = asRecord(raw);
  const id = asString(decl.id);
  if (id === null || !world.entityIds.includes(id)) {
    builder.fail(`${where}: mind names no declared entity`);
    return null;
  }
  if (id === world.actor) {
    // Hráčovu entitu hýbe vstup ve fázi 0, mysl by ji hýbala ve fázi 3 — tedy
    // později, takže by hráčův vlastní tah přepsala každý tik. Svět by přestal
    // reagovat na ovládání a ověřovač by ho odmítl jako nedohratelný, aniž by
    // šlo poznat proč. Role se **nekontroluje**: `role` je volný identifikátor
    // a mysl na `npc` nebo `shopkeeper` je legitimní; vadný je jen střet
    // s hráčem.
    builder.fail(`${where}: ${id} is the player, and a mind would overwrite the player's own move`);
    return null;
  }

  const disposition = asString(decl.disposition);
  if (!isDisposition(disposition)) {
    builder.fail(`${where}: ${String(decl.disposition)} is not a known disposition`);
    return null;
  }

  const goals = asArray(decl.goals).map(asString);
  if (goals.length === 0 || goals.length > MAX_AGENT_GOALS || goals.includes(null)) {
    builder.fail(`${where}: goals must be 1 to ${MAX_AGENT_GOALS} names`);
    return null;
  }

  const route = goals as string[];
  for (const goal of route) {
    // Cíl musí být soket, protože `moveTo` míří na soket a `onEnterZone` čte
    // zónu — `buildZones` dělá ze soketu obojí. Neznámý cíl by byl tichý no-op:
    // `applyEffect` na neznámém soketu vrací `ok` a nikam nejde.
    if (!(goal in sockets)) {
      builder.fail(`${where}: goal ${goal} is not a declared socket`);
      return null;
    }
    // Jméno cíle je zároveň symbol v paměti, takže musí projít `SYMBOL_PATTERN`.
    if (!SYMBOL_PATTERN.test(goal)) {
      builder.fail(`${where}: goal ${goal} is not a usable memory symbol`);
      return null;
    }
  }
  if (new Set(route).size !== route.length) {
    // Dvakrát tentýž cíl by udělal z paměti nejednoznačnou pozici: stráž
    // `memory[goal] = jméno` by seděla na obou výskytech a trasa by se větvila.
    builder.fail(`${where}: goals repeat a name, so a position cannot be told from memory`);
    return null;
  }

  return { id, disposition, goals: route };
}

/**
 * Snížení jedné mysli na sloty a pravidla.
 *
 * Pravidel je `1 + goals.length * AGENT_DISPOSITIONS.length`: jedno startovní a
 * pro každou zastávku jedno na každou povahu. Predikát `onEnterZone` je na
 * zastávku jeden a sdílejí ho všechny tři povahy — o tu deduplikaci se stará
 * `Builder.predicate`.
 */
function lowerMind(mind: AgentMind, world: World, builder: Builder): void {
  const { id, goals } = mind;

  builder.slots.push({
    space: 'memory',
    id: moodSlotId(id),
    agent: id,
    index: AGENT_MOOD_INDEX,
    values: [...AGENT_DISPOSITIONS],
    initial: mind.disposition,
  });
  builder.slots.push({
    space: 'memory',
    id: goalSlotId(id),
    agent: id,
    index: AGENT_GOAL_INDEX,
    values: [...goals],
    initial: goals[0],
  });

  const start: SurfaceEventSpec = { event: 'onStart' };
  const started = lowerEvent(start, builder.table, world);
  builder.rules.push({
    ruleId: `mind.${id}.begin`,
    phase: AGENT_PHASE,
    priority: 0,
    trigger: {
      kind: 'onEdge',
      predicate: builder.predicate(predicateIdFor(start), 'onStart', started.expr),
      became: started.became,
    },
    guard: null,
    // `ticks` je prodleva před prvním krokem a schéma žádá aspoň jedničku;
    // `sys.moveTo` z `ir/build.ts` používá tutéž hodnotu, takže se postava
    // rozejde ve stejném rytmu jako hráč.
    effects: [builder.effect({ op: 'moveTo', entity: id, socket: goals[0], ticks: 1 })],
  });

  const moodRef = { space: 'memory', agent: id, index: AGENT_MOOD_INDEX } as const;
  const goalRef = { space: 'memory', agent: id, index: AGENT_GOAL_INDEX } as const;
  const moodNode = builder.table.add({ kind: 'ref', ref: moodRef });
  const goalNode = builder.table.add({ kind: 'ref', ref: goalRef });

  for (let at = 0; at < goals.length; at += 1) {
    const here = goals[at];
    const arrival: SurfaceEventSpec = { event: 'onEnterZone', entity: id, zone: here };
    const lowered = lowerEvent(arrival, builder.table, world);
    const predicate = builder.predicate(predicateIdFor(arrival), 'onEnterZone', lowered.expr);
    const atHere = builder.table.add({ kind: 'compare', lhs: goalNode, op: '=', rhs: builder.literal(here) });

    for (const disposition of AGENT_DISPOSITIONS) {
      const next = goals[nextGoalIndex(disposition, at, goals.length)];
      const isMood = builder.table.add({
        kind: 'compare',
        lhs: moodNode,
        op: '=',
        rhs: builder.literal(disposition),
      });
      builder.rules.push({
        ruleId: `mind.${id}.${disposition}.${String(at)}`,
        phase: AGENT_PHASE,
        priority: 1,
        trigger: { kind: 'onEdge', predicate, became: lowered.became },
        guard: builder.table.add({ kind: 'allOf', operands: [isMood, atHere] }),
        effects: [
          builder.effect({ op: 'assign', ref: goalRef, value: builder.literal(next) }),
          builder.effect({ op: 'moveTo', entity: id, socket: next, ticks: 1 }),
        ],
      });
    }
  }
}

/**
 * Přečte `sim.state.agents` a zapíše mysli do stavějícího se dokumentu.
 *
 * Vrací přečtené mysli, protože `buildRuntimeWorld` z nich dopočítá `maxAgents`
 * a `memorySlotsPerAgent` — meze, které pak `validateIrDoc` vynucuje proti
 * skutečnému počtu paměťových slotů.
 */
export function expandAgentMinds(
  declared: unknown,
  world: World,
  sockets: Readonly<Record<string, readonly [number, number]>>,
  builder: Builder,
): readonly AgentMind[] {
  if (declared !== undefined && !Array.isArray(declared)) {
    // Každá jiná nádoba ve `state` je objekt klíčovaný jménem, takže `agents`
    // napsané jako objekt je nejpravděpodobnější vadná emise. `asArray` by z něj
    // udělalo prázdný seznam a svět by vznikl **bez jediné mysli** — tichý no-op
    // přesně toho druhu, jaký `readMind` u každého jednotlivého pole odmítá.
    builder.fail('state.agents: minds must be a list');
    return [];
  }
  const entries = asArray(declared);
  const minds: AgentMind[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < entries.length; i += 1) {
    const mind = readMind(entries[i], world, sockets, builder, `state.agents[${String(i)}]`);
    if (mind === null) continue;
    if (claimed.has(mind.id)) {
      builder.fail(`state.agents[${String(i)}]: ${mind.id} already has a mind`);
      continue;
    }
    claimed.add(mind.id);
    minds.push(mind);
    lowerMind(mind, world, builder);
  }
  return minds;
}

/** Kolik paměťových slotů svět s těmihle myslemi potřebuje na agenta. */
export function memorySlotsFor(minds: readonly AgentMind[]): number {
  return minds.length === 0 ? 0 : AGENT_MEMORY_SLOTS;
}

/**
 * Zóny, ve kterých entita během prvních `ticks` tiků stála.
 *
 * Čte se **odvozený fakt `inZone`, jak ho tik viděl na svém začátku** — tedy
 * stav, ze kterého se pravidla toho tiku rozhodovala. Zóna, do které postava
 * vkročí až úklidem posledního tiku, patří tiku `ticks` a v odpovědi proto
 * není; je to hranice okna, ne ztracené pozorování.
 *
 * Je to **oracle chování**, ne pomůcka pro testy: o mysli se nedá zvenčí říct
 * nic jiného, než kudy postava chodila. Počítá se čerstvým během od tiku nula,
 * takže odpověď nezávisí na tom, jak kdo předtím hýbal posuvníkem času.
 *
 * Zóna se nečte parsováním klíče faktu, ale jeho **složením** přes `factKey` nad
 * deklarovanými jmény — druhý čtenář kanonického tvaru by byl druhá definice
 * toho, co „být v zóně" znamená.
 */
export function visitedZones(doc: WorldDocRuntime, entity: string, ticks: number): readonly string[] {
  const runtime = createRuntime(doc);
  const zoneNames = Object.keys(doc.space.zones);
  const seen = new Set<string>();

  for (let i = 0; i < ticks && runtime.runState === 'running'; i += 1) {
    const at = runtime.tick;
    step(
      runtime,
      doc.trace.filter((entry) => entry.tick === at),
    );
    for (const zone of zoneNames) {
      if (runtime.previous.facts.has(factKey('inZone', [entity, zone]))) seen.add(zone);
    }
  }
  return [...seen].sort();
}
