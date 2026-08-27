/**
 * Hra: věta se stane světem, svět se dá hrát rukou (P11 T19).
 *
 * ## Hráčův stisk se zapisuje do stopy, ne mimo ni
 *
 * Do T19 hlavní větev vstup neměla vůbec — `WorldScene` přehrával `world.trace`,
 * tedy zaznamenaného svědka. Živé ovládání ten zdroj **nenahrazuje, rozšiřuje**:
 * každý stisk se orazítkuje tikem a uloží do téže stopy, jakou čte replay. Běh
 * tím zůstává funkcí `(dokument, stopa)` — a to není úklid, to je celá teze
 * projektu. Vstup, který by se do stopy nezapsal, by udělal z běhu funkci nástěnného
 * času a přetáčení času z T17 i certifikát svědka by přestaly o hře cokoli tvrdit.
 *
 * ## Proč se tik razítkuje až při spotřebování
 *
 * Klávesa padne mezi tiky, ne na tik. Kdyby si stisk vzal `tick()` v okamžiku
 * stisku, trefil by tik, který smyčka právě odkrokovala — a `inputsForTick` by ho
 * zahodila, protože ten tik už je za ní. Fronta proto čeká a razítko dostane od
 * toho tiku, který si pro ni doopravdy přijde. Žádný stisk se neztratí a stopa
 * nese tiky, ve kterých se vstup **vykonal**.
 *
 * ## Slovník je ten, který má svědek — a nic mimo něj
 *
 * `moveTo`, `pickup`, `use`. Přesně ta tři slovesa používá `witnessOf` v
 * `src/model/local/shapes.ts`, takže cokoli, co umí vyhrát svědek, umí zahrát i
 * ruka. Nové sloveso se **nezavádí**: akce, na kterou žádné pravidlo neposlouchá,
 * skončí v `src/sim/interpreter.ts` jako fakt `acted(...)`, který nic nepřečte —
 * je to tichý no-op, ne chyba, takže špatná klávesa svět nerozbije.
 */

import type { RunState, TraceInput, WorldDocRuntime } from '@/sim/interpreter';

/** Fáze hry, jak ji vidí divák. */
export type GamePhase = 'building' | 'playing' | 'won' | 'lost';

/** Co hráč chce udělat. Cíl je vždy jmenovaná entita, nikdy souřadnice. */
export interface PlayerIntent {
  readonly actionId: string;
  readonly target: string;
}

/** Entita s pozicí, jak ji vrací plátno. Strukturální tvar, ať `src/game` nesahá do komponent. */
export interface PlacedEntity {
  readonly stableId: string;
  readonly cell: readonly [number, number];
}

/**
 * Kdo je hráč.
 *
 * **Totéž pravidlo jako `src/ir/build.ts`**, které podle něj vyrábí pravidla
 * `sys.moveTo.*` — kdyby se ty dvě odpovědi rozešly, ovládání by posílalo akce
 * jménem entity, které žádné pravidlo pohybu nepatří, a svět by na klávesy tiše
 * nereagoval. Shodu drží připnutou test v `src/game/__tests__/flow.test.ts`.
 */
export function actorOf(doc: WorldDocRuntime): string | null {
  const entities = doc.ir.entities;
  return entities.find((entity) => entity.role === 'actor')?.stableId ?? entities[0]?.stableId ?? null;
}

/**
 * Cíle, na které jde ukázat klávesou.
 *
 * Pořadí je pořadí entit v dokumentu, ne abecední: emise je píše v pořadí, ve
 * kterém se hrají (nejdřív sběr, cíl naposled), takže čísla kláves vyjdou na
 * přirozený postup. Bere se jen entita s **deklarovaným soketem** — bez něj
 * `sys.moveTo.*` nevznikne a klávesa by nedělala nic.
 */
export function playableTargets(doc: WorldDocRuntime): readonly string[] {
  const actor = actorOf(doc);
  return doc.ir.entities
    .filter((entity) => entity.stableId !== actor && entity.socket in doc.space.sockets)
    .map((entity) => entity.stableId);
}

/** Stojí hráč na cíli? Jediný způsob, jak zvenčí poznat, že chůze dojela. */
export function arrivedAt(placed: readonly PlacedEntity[], actor: string, target: string): boolean {
  const at = placed.find((entity) => entity.stableId === actor)?.cell;
  const goal = placed.find((entity) => entity.stableId === target)?.cell;
  return at !== undefined && goal !== undefined && at[0] === goal[0] && at[1] === goal[1];
}

/**
 * Fáze hry ze tří pozorovaných čísel.
 *
 * `building` se čte z **rozvrhu stavby** (T11), ne z „svět ještě není": svět
 * vzniká v jednom kroku, takže fáze odvozená z jeho existence by trvala nula
 * milisekund a nikdo — ani test — by ji nezahlédl. Rozvrh stavby trvá stovky
 * milisekund a je vidět, takže je to fáze, o které se dá mluvit.
 */
export function phaseOf(observed: {
  readonly hasWorld: boolean;
  readonly revealed: number;
  readonly total: number;
  readonly runState: RunState;
}): GamePhase {
  if (observed.runState === 'won') return 'won';
  if (observed.runState !== 'running') return 'lost';
  if (!observed.hasWorld || observed.revealed < observed.total) return 'building';
  return 'playing';
}

/** Klávesa → záměr, nad daným seznamem cílů a naposledy vybraným cílem. */
export function intentFromKey(
  key: string,
  targets: readonly string[],
  selected: string | null,
): PlayerIntent | null {
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : null;
  if (digit !== null) {
    const target = targets[digit];
    return target === undefined ? null : { actionId: 'moveTo', target };
  }
  if (selected === null) return null;
  if (key === ' ') return { actionId: 'pickup', target: selected };
  if (key === 'e' || key === 'E') return { actionId: 'use', target: selected };
  return null;
}

/**
 * Fronta stisků a stopa, kterou z nich vznikne.
 *
 * `take` je jediné místo, kde se razítkuje tik, a zapisuje **zároveň** do stopy —
 * dvě cesty (jedna pro běh, druhá pro záznam) by znamenaly dvě různé pravdy o tom,
 * co hráč zahrál.
 */
export interface Controls {
  /** Zpracuje klávesu. Vrací záměr, který z ní vznikl, nebo `null`, když nic. */
  readonly press: (key: string, targets: readonly string[]) => PlayerIntent | null;
  /** Naposledy vybraný cíl. */
  readonly selected: () => string | null;
  /** Vstupy pro tenhle tik. Vyprázdní frontu a připíše je do stopy. */
  readonly take: (tick: number, actor: string) => readonly TraceInput[];
  /** Co hráč zahrál, v pořadí a s tiky. Přehráním se dostane týž běh. */
  readonly log: () => readonly TraceInput[];
  /** Nová hra: prázdná fronta, prázdná stopa, nevybraný cíl. */
  readonly reset: () => void;
}

export function createControls(): Controls {
  let pending: PlayerIntent[] = [];
  let recorded: TraceInput[] = [];
  let selected: string | null = null;

  return {
    press: (key, targets) => {
      const intent = intentFromKey(key, targets, selected);
      if (intent === null) return null;
      if (intent.actionId === 'moveTo') selected = intent.target;
      pending.push(intent);
      return intent;
    },
    selected: () => selected,
    take: (tick, actor) => {
      if (pending.length === 0) return [];
      const inputs = pending.map((intent): TraceInput => ({ tick, actor, ...intent }));
      pending = [];
      recorded = [...recorded, ...inputs];
      return inputs;
    },
    log: () => recorded,
    reset: () => {
      pending = [];
      recorded = [];
      selected = null;
    },
  };
}
