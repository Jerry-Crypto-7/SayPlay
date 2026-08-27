/**
 * Změnit pravidlo v minulosti a nechat budoucnost přepočítat (P11 T17).
 *
 * Přetočení času samo o sobě je jen navigace. Tohle je ta část, kvůli které
 * stojí za to ho mít: svět se vrátí na tik 40, jedno pravidlo se změní, a od
 * toho tiku dál se běh počítá znovu — podle nových pravidel, ale ze **starého
 * stavu**, který si do té chvíle odžil podle starých.
 *
 * ## Proč se stav přesazuje a nepřepisuje se od nuly
 *
 * Nový dokument znamená nový runtime (`createRuntime` staví layout, tabulky
 * symbolů a pořadí pravidel z dokumentu). Zabalený stav z tiku 40 do něj ale
 * musí přejít beze změny, jinak by se nejednalo o změnu pravidla v minulosti,
 * ale o jiný svět od začátku. Přesazení je legální jen tehdy, když se **tvar
 * světa nezměnil** — sloty, symboly a prostor. To se tu kontroluje a při
 * neshodě se odmítá, protože přesadit pole čísel do jinak rozvrženého runtimu
 * znamená, že každé číslo začne znamenat něco jiného, a nic nespadne.
 *
 * ## Co se změnit smí
 *
 * Graf pravidel: `rules`, `predicates`, `nodes`, `effects`. Ty do zabaleného
 * stavu nevstupují — čtou ho a píší do něj, ale samy v něm nesedí. Proto smí
 * větev vyjít z pozorování pořízeného ještě podle starých pravidel: pozorování
 * je popis stavu, ne hodnot predikátů, a nový dokument si je vyhodnotí sám.
 */

import { createRuntime, type Runtime, type SpaceDecl, type WorldDocRuntime } from './interpreter';
import { createTimeline, seekTo, type Timeline } from './timeline';

export type RebranchReason =
  /** Osa na ten tik nedosáhne — leží před kotvou, nebo běh skončil dřív. */
  | 'TICK_UNREACHABLE'
  /** Změnil se tvar světa, ne jen jeho pravidla. Zabalený stav by přestal sedět. */
  | 'SHAPE_CHANGED';

export interface RebranchRejection {
  readonly verdict: 'REJECTED';
  readonly reason: RebranchReason;
  /** Věta pro člověka. Říká, co konkrétně nesedí, ne jen že něco. */
  readonly detail: string;
}

export interface RebranchCommit {
  readonly verdict: 'REBRANCHED';
  /** Runtime nad novým dokumentem, stojící na tiku větvení se starým stavem. */
  readonly runtime: Runtime;
  /** Nová osa, kotvená v tiku větvení. Minulost patří té staré. */
  readonly timeline: Timeline;
  readonly tick: number;
}

export type RebranchResult = RebranchCommit | RebranchRejection;

function rejected(reason: RebranchReason, detail: string): RebranchRejection {
  return { verdict: 'REJECTED', reason, detail };
}

/**
 * Rozvržení zabaleného stavu.
 *
 * `initial` je ve srovnání schválně. Změna počáteční hodnoty je změna tiku
 * nula, a z tiku 40 se odbočit nedá — větev by ji tiše ignorovala a vypadala
 * přitom, že ji přijala.
 */
function sameLayout(was: Runtime, now: Runtime): string | null {
  const before = was.layout.slots;
  const after = now.layout.slots;
  if (before.length !== after.length) return `slot count ${before.length} -> ${after.length}`;
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    const b = after[i];
    if (a.id !== b.id) return `slot ${i} was ${a.id}, is now ${b.id}`;
    if (a.kind !== b.kind || a.min !== b.min || a.max !== b.max) return `slot ${a.id} changed its range`;
    if (a.initial !== b.initial) return `slot ${a.id} changed its initial value`;
  }
  return null;
}

/**
 * Tabulky symbolů. Slot drží **index** do seznamu hodnot, takže přeházený
 * seznam nechá čísla na místě a jejich význam vymění — vada, kterou rozvržení
 * nevidí, protože meze slotu zůstanou stejné.
 */
function sameSymbols(before: Runtime['entityStates'], after: Runtime['entityStates'], what: string): string | null {
  if (before.size !== after.size) return `${what} count ${before.size} -> ${after.size}`;
  for (const [id, table] of before) {
    const next = after.get(id);
    if (next === undefined) return `${what} ${id} is gone`;
    if (table.values.length !== next.values.length) return `${what} ${id} changed its value count`;
    for (let i = 0; i < table.values.length; i += 1) {
      if (table.values[i] !== next.values[i]) return `${what} ${id} reordered or renamed its values`;
    }
  }
  return null;
}

/**
 * Prostor. Pozici entit nese zabalený stav jako souřadnice, takže přesunutý
 * socket nebo posunutá zóna znamená, že tatáž čísla popisují jiné místo — a
 * pozorování z minulého tiku, ze kterého větev čte hrany, popisuje jinou
 * místnost.
 */
function sameSpace(before: SpaceDecl, after: SpaceDecl): string | null {
  const sockets = (space: SpaceDecl) =>
    Object.entries(space.sockets)
      .map(([id, [x, y]]) => `${id}@${String(x)},${String(y)}`)
      .sort()
      .join(';');
  const zones = (space: SpaceDecl) =>
    Object.entries(space.zones)
      .map(([id, rect]) => `${id}@${rect.join(',')}`)
      .sort()
      .join(';');
  const blocked = (space: SpaceDecl) =>
    space.blocked
      .map((cell) => cell.join(','))
      .sort()
      .join(';');
  const tags = (space: SpaceDecl) =>
    Object.entries(space.tags)
      .map(([id, tag]) => `${id}=${tag}`)
      .sort()
      .join(';');

  if (sockets(before) !== sockets(after)) return 'sockets moved';
  if (zones(before) !== zones(after)) return 'zones moved';
  if (blocked(before) !== blocked(after)) return 'blocked cells changed';
  if (tags(before) !== tags(after)) return 'entity tags changed';
  return null;
}

function shapeMismatch(was: Runtime, now: Runtime): string | null {
  return (
    sameLayout(was, now) ??
    sameSymbols(was.entityStates, now.entityStates, 'entity states') ??
    sameSymbols(was.slotEnums, now.slotEnums, 'slot symbols') ??
    sameSpace(was.doc.space, now.doc.space)
  );
}

/**
 * Přetočí `runtime` na `tick`, přesadí jeho stav do runtimu nad `nextDoc`
 * a vrátí novou větev stojící na témž tiku.
 *
 * **Vstupní runtime se tím posune** — přetáčení je jeho vlastní operace a
 * schovávat ji za kopii by znamenalo mít dvě různá „teď". Volající, který chce
 * obě větve vedle sebe, si postaví druhý runtime; k tomu je `createRuntime`.
 *
 * Budoucnost se tu **nepočítá**. Větev stojí na tiku větvení a dopočítá si ji
 * volající — `seekTo` nad vrácenou osou, nebo `run`. Rozdíl mezi „odbočilo se"
 * a „doběhlo se do horizontu" je rozdíl, který má vidět ten, kdo o něj požádal.
 */
export function rebranchAt(
  timeline: Timeline,
  runtime: Runtime,
  tick: number,
  nextDoc: WorldDocRuntime,
): RebranchResult {
  const reached = seekTo(timeline, runtime, tick);
  if (reached !== tick) {
    return rejected('TICK_UNREACHABLE', `asked for tick ${String(tick)}, the timeline reaches ${String(reached)}`);
  }

  const next = createRuntime(nextDoc);
  const mismatch = shapeMismatch(runtime, next);
  if (mismatch !== null) {
    return rejected('SHAPE_CHANGED', `${mismatch} — a branch from the middle can only change the rules`);
  }

  next.state.set(runtime.state);
  next.tick = runtime.tick;
  next.runState = runtime.runState;
  next.fault = runtime.fault;
  next.drainQueue = runtime.drainQueue.slice();
  next.previous = runtime.previous;

  return { verdict: 'REBRANCHED', runtime: next, timeline: createTimeline(next, timeline.capacity), tick };
}
