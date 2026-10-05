/**
 * Události herní smyčky (P27D T4, B4): co hráč s hrou udělal, bez jediného
 * slova, které napsal. Událost je jméno z uzavřeného seznamu, id verze a
 * náhodné id relace záložky – nic dalšího dveře nepřijmou, takže věta, jméno
 * ani adresa do záznamu cestou nepropadne.
 *
 * Robot ověřovače a ukázka „Show me how“ nejsou hráč: klient za ně nic
 * nepošle (`ArcadePlay`, `PlayShell`), tady se jen počítá.
 */

export const LOOP_EVENTS = ['impression', 'first_input', 'win', 'lose', 'restart', 'next_game', 'share', 'shared_open'] as const;
export type LoopEventName = (typeof LOOP_EVENTS)[number];

export interface LoopEvent {
  readonly name: LoopEventName;
  readonly versionId: string;
  readonly session: string;
  /** Jen u `share` (P29D T2): šel se sdílením i klip běhu, nebo jen odkaz. */
  readonly withClip?: boolean;
  /** Jen u `share` (P36B T6): odkaz nesl výzvu Dare s ověřeným skóre. */
  readonly dare?: boolean;
}

const VERSION = /^[a-f0-9]{8,64}$/;
const SESSION = /^[a-z0-9]{12,32}$/;
const KEYS = new Set(['name', 'versionId', 'session', 'withClip', 'dare']);

/** Tělo z dveří → událost, nebo `null`. Klíč navíc (třeba `sentence`) celé tělo odmítne. */
export function readLoopEvent(raw: unknown): LoopEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => !KEYS.has(key))) return null;
  const { name, versionId, session } = body;
  if (typeof name !== 'string' || !(LOOP_EVENTS as readonly string[]).includes(name)) return null;
  if (typeof versionId !== 'string' || !VERSION.test(versionId)) return null;
  if (typeof session !== 'string' || !SESSION.test(session)) return null;
  const { withClip, dare } = body;
  if (withClip === undefined && dare === undefined) return { name: name as LoopEventName, versionId, session };
  if (name !== 'share') return null;
  if (withClip !== undefined && typeof withClip !== 'boolean') return null;
  if (dare !== undefined && typeof dare !== 'boolean') return null;
  return { name, versionId, session, ...(withClip === undefined ? {} : { withClip }), ...(dare === undefined ? {} : { dare }) };
}

/**
 * Čítače, podle kterých feed řadí (P36B T9): dohrání (výhra i prohra), výzva
 * Dare a přeskočení (`next_game`). Výzvu započtou jen dveře výzvy, když server
 * uloží novou ověřenou výzvu – `share` s `dare: true` je slovo klienta a
 * nepočítá se (nález revize T9-1). Pokus (`first_input`) a výhra dávají
 * „clear rate“ (P37C T5). Ostatní události nic nepočítají.
 */
export type LoopCounter = 'finish' | 'dare' | 'skip' | 'start' | 'clear';
export const LOOP_COUNTERS: readonly LoopCounter[] = ['finish', 'dare', 'skip', 'start', 'clear'];

/**
 * Čítače, které událost z dveří událostí zvýší; výzvu (`dare`) nikdy – tu počítají
 * dveře výzvy. Konec běhu je i pokus: klient posílá `first_input` jen po vstupu,
 * a nečinný hráč hry na přežití vyhraje bez něj (nález revize T5-1 #1). Hlas je
 * týž klíč, takže pokus se tím za den nezapočte dvakrát.
 */
export function loopCountersOf(event: LoopEvent): readonly Exclude<LoopCounter, 'dare'>[] {
  if (event.name === 'win') return ['start', 'finish', 'clear'];
  if (event.name === 'lose') return ['start', 'finish'];
  if (event.name === 'next_game') return ['skip'];
  if (event.name === 'first_input') return ['start'];
  return [];
}

/** Od kolika pokusů má „N% beat this“ smysl; pod tím feed ani výsledek nic neříkají. */
export const CLEAR_RATE_MIN_STARTS = 10;

/**
 * „Clear rate“ (P37C T5): kolik procent pokusů skončilo výhrou, celé číslo, nebo
 * `null` pod `CLEAR_RATE_MIN_STARTS` pokusů. Oba čítače mají jeden hlas volajícího
 * za den; výhra bez pokusu (podvržená událost) procento přes 100 nezvedne.
 */
export function clearRate(starts: number, clears: number): number | null {
  if (starts < CLEAR_RATE_MIN_STARTS) return null;
  return Math.round((100 * Math.min(clears, starts)) / starts);
}

export interface LoopRate {
  readonly hit: number;
  readonly of: number;
}

export interface LoopReport {
  readonly sessions: number;
  /** Unikátní dvojice relace × verze pro každou událost. */
  readonly counts: Readonly<Record<LoopEventName, number>>;
  /**
   * Poměry se skutečným jmenovatelem. `sharedOpenPerShare` je otevření
   * sdíleného odkazu na jedno sdílení – dokončená nabídka sdílení není
   * doručený odkaz, a proto se jmenovatel nejmenuje „delivered“.
   */
  readonly rates: {
    readonly played: LoopRate;
    readonly finished: LoopRate;
    readonly restarted: LoopRate;
    readonly movedOn: LoopRate;
    readonly shared: LoopRate;
    readonly sharedOpenPerShare: LoopRate;
  };
}

/**
 * Záznam → trychtýř. `impression`, `first_input` a `shared_open` se počítají
 * jednou za relaci a verzi; konec hry, restart, další hra a sdílení každý
 * zvlášť (hráč smí hrát dvakrát).
 */
export function summarizeLoop(events: readonly LoopEvent[]): LoopReport {
  const once = new Set<LoopEventName>(['impression', 'first_input', 'shared_open']);
  const seen = new Set<string>();
  const counts = Object.fromEntries(LOOP_EVENTS.map((name) => [name, 0])) as Record<LoopEventName, number>;
  for (const event of events) {
    const key = `${event.name}|${event.session}|${event.versionId}`;
    if (once.has(event.name)) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    counts[event.name] += 1;
  }
  const rate = (hit: number, of: number): LoopRate => ({ hit, of });
  return {
    sessions: new Set(events.map((event) => event.session)).size,
    counts,
    rates: {
      played: rate(counts.first_input, counts.impression),
      finished: rate(counts.win + counts.lose, counts.first_input),
      restarted: rate(counts.restart, counts.win + counts.lose),
      movedOn: rate(counts.next_game, counts.impression),
      shared: rate(counts.share, counts.impression),
      sharedOpenPerShare: rate(counts.shared_open, counts.share),
    },
  };
}
