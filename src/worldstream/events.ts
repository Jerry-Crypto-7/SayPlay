/**
 * **Události relace a log, ve kterém nejsou mezery** (P13 vlna 3, T15).
 *
 * Design book §20. Rámec má pět polí a `sequence` je jediné, které rozhoduje
 * o pořadí — `at` je **observační a nikdy neřídí stav**. Je to tentýž zákaz
 * jako na replay cestě (`CLAUDE.md`, determinismus): kdo řadí podle času,
 * přerovná si stav podle toho, jak byl vytížený stroj.
 *
 * ## Dvě vlastnosti, na kterých stojí reconnect
 *
 * 1. **Bez mezer a bez duplicit.** Klient si drží poslední `sequence` a po
 *    připojení si vyžádá snapshot plus události za tím číslem (§20). Mezera
 *    znamená, že klient neví, jestli mu něco uteklo; duplicita znamená, že
 *    tentýž přechod proběhne dvakrát. Číslo proto mintuje **výhradně** tenhle
 *    log a mintuje ho až ve chvíli, kdy je jasné, že se událost zapíše.
 *
 * 2. **Progress rámce se smějí slučovat, stavové přechody nikdy.** Backpressure
 *    z §20. Sloučení je tady zapsané jako **přepis konce logu při zachování
 *    jeho `sequence`**, ne jako zahození — zahodit rámec uprostřed by udělalo
 *    přesně tu mezeru, kterou vlastnost 1 zakazuje.
 *
 * ## Proč se slučuje podle `subject`, ne jen podle typu
 *
 * Tvary se meshují za sebou a rámce se proplétají: `refining(A)`, `refining(B)`,
 * `refining(A)`. Sloučení podle samotného typu by nechalo Béčko spolknout
 * Áčkem a klient by se o Béčku nedozvěděl. `subject` je proto povinný argument
 * volajícího, ne hodnota vyčtená z payloadu — payload je `unknown` a hádat
 * v něm klíč znamená hádat i tam, kde žádný není.
 *
 * `subject` **nejde přes drát**. Rámec má podle §20 pět polí a šesté by byl
 * nový kontrakt kvůli tomu, co si server spočítal sám.
 */

/** Slovník §20. Pořadí je pořadí té sekce. */
export const SESSION_EVENT_TYPES = [
  'session.accepted',
  'intent.ready',
  'blueprint.ready',
  'world.ready',
  'shape.queued',
  'shape.coarse',
  'shape.refining',
  'shape.ready',
  'shape.failed',
  'patch.preview',
  'patch.committed',
  'patch.rejected',
  'branch.created',
  'session.complete',
  'session.failed',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Které typy se smějí sloučit s bezprostředně předchozím rámcem téhož
 * `subject`.
 *
 * **Slučuje se to, co NENÍ stavový přechod**, a jsou to dvě věci z patnácti.
 * Rozšiřovat tenhle seznam „pro jistotu" znamená mazat přechody, které
 * klientský reducer potřebuje vidět; §20 tři z nich (`ready`, `failed`,
 * `committed`) jmenuje výslovně a ty se sem nesmějí dostat nikdy.
 *
 * `shape.refining` je **průběh**: říká, že se na tvaru pracuje, a novější
 * zpráva starší nahrazuje beze ztráty.
 *
 * `patch.rejected` je **oznámení o nepřechodu** (P15 `T22-rejectflood`).
 * Odmítnutý patch z definice nechal svět tam, kde byl — do dokumentu nešel ani
 * bajt — takže rámec nenese přechod, který by šlo sloučením ztratit. Přibyl
 * sem proto, že `b398521` (`T22-takeearly`) nechal odmítnuté preview **ležet
 * dál**, a tím se rozvázala mez „jeden rámec na jedno zaplacené volání
 * modelu": N opakovaných POSTů na tentýž `changeId` vyrobilo N rámců, přestože
 * se zaplatilo jednou.
 *
 * ⚠ **Na automat relace to nemá vliv a je to změřené, ne odhadnuté.**
 * `isCoalescable` čte kromě logu jen `session.ts`, a tam výhradně přes
 * `RUNG_EVENT[next.kind]`, jehož obor hodnot jsou **čtyři** příčky žebříku
 * (`shape.coarse`, `shape.refining`, `shape.ready`, `shape.failed`).
 * `patch.rejected` mezi ně nepatří, takže se otázka „smí se ta příčka
 * zopakovat" na něj nikdy nezeptá: **nula dotčených příček.**
 *
 * ⚠ **Co to NEOHRANIČUJE, a nesmí se tvrdit opak.** Slučuje se jedině s
 * **koncem** logu, takže kdo drží dvě preview nad dvěma různými objekty a
 * odmítnutí střídá, dostane rámce dva a dva a neslije se nic. Tvrdou mez tady
 * dnes dává strop frekvence na dveřích `commit` (`T28-editrate`) a měla by ji
 * dávat i eviction relace, která je ale rozbitá (`T16-evictworld`). Tohle
 * zavírá levný případ — opakování téhož odmítnutí zadarmo — ne všechny.
 */
export const COALESCABLE_EVENT_TYPES: readonly SessionEventType[] = [
  'shape.refining',
  'patch.rejected',
];

/**
 * Smí se rámec toho typu sloučit s předchozím?
 *
 * Ptá se na to i automat relace, a je to **schválně tatáž otázka**: příčka
 * žebříku se smí zopakovat právě tehdy, když se její rámec smí sloučit.
 * Kdyby to byly dva seznamy, dal by se vyrobit průběh, který se opakuje a
 * neslučuje (proud roste bez konce), nebo přechod, který se slučuje a
 * neopakuje (klient o něm neví).
 */
export function isCoalescable(type: SessionEventType): boolean {
  return COALESCABLE_EVENT_TYPES.includes(type);
}

/** Rámec proudu, přesně pět polí z §20. */
export interface SessionEvent<T = unknown> {
  readonly sessionId: string;
  /** Monotónní, rozhoduje pořadí. První událost relace má 1. */
  readonly sequence: number;
  readonly type: SessionEventType;
  /** Observační. **Nikdy** neřídí stav ani pořadí. */
  readonly at: string;
  readonly payload: T;
}

export interface SessionEventLog {
  /** Poslední přidělené číslo. Prázdný log má 0. */
  readonly sequence: number;
  readonly length: number;
  /**
   * Kolik odběratelů proud právě drží.
   *
   * Registr to čte jako **známku života relace** (`idleFor` v `sessions.ts`).
   * Otevřený SSE proud je jediné, co o přítomnosti diváka vypovídá i tehdy,
   * když `sequence` stojí — a po `world.ready` stojí skoro pořád, protože
   * meshuje prohlížeč a serveru se do logu nic nehlásí.
   */
  readonly watchers: number;
  /**
   * Zapíše rámec a přidělí mu číslo — nebo sloučí s koncem logu, když to
   * `COALESCABLE_EVENT_TYPES` dovolí. Vrací rámec, který v logu skutečně stojí.
   */
  append(type: SessionEventType, payload: unknown, subject?: string): SessionEvent;
  /** Rámce s `sequence > after`, v pořadí. Prázdné pole, když klient předběhl. */
  since(after: number): readonly SessionEvent[];
  all(): readonly SessionEvent[];
  /**
   * Živý odběr. Vrací funkci, která ho zruší.
   *
   * **Sloučený rámec se posílá taky**, takže odběratel může dostat `sequence`,
   * které už jednou viděl, s novějším obsahem. Je to přímý důsledek §20 —
   * průběh se slučuje — a je to přesně ten důvod, proč klientský reducer musí
   * být idempotentní na duplicitní rámec (T17).
   *
   * Odběratel, který vyhodí, se **odhlásí**. Typický odběratel je zápis do
   * SSE proudu a ten vyhodí právě tehdy, když protistrana odešla; nechat tu
   * výjimku proletět znamená, že odchod jednoho diváka zabije generaci
   * uprostřed pro všechny ostatní.
   */
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

interface LoggedEvent {
  event: SessionEvent;
  readonly subject: string;
}

export interface EventLogOptions {
  /**
   * Odkud se bere `at`. Testy sem dosadí pevné hodiny; nikdo se podle nich
   * nerozhoduje, takže na produkci stačí výchozí.
   */
  readonly now?: () => string;
  /**
   * Od jakého čísla se pokračuje. Obnovená relace navazuje na `sequence`
   * ze snapshotu, aby klient s vyšším číslem nedostal rámec, který už viděl.
   */
  readonly startAt?: number;
}

/**
 * Log jedné relace. Nemá strop a je to vědomé: jedna věta vyrobí desítky
 * rámců, ne desetitisíce, a to, co ten počet nafukuje — průběh tvaru
 * a opakované odmítnutí — slučování shora omezuje.
 *
 * ⚠ **„Desítky, ne desetitisíce" je předpoklad, ne mechanismus**, a od
 * `T22-takeearly` ho drží až brány o patro výš: strop frekvence na veřejných
 * dveřích (`src/server/rate-limit.ts`) a uvolňování relací z registru
 * (`T16-evictworld`, dnes rozbité). Strop na délku logu tady schválně není —
 * `since(after)` je jediná cesta, kudy se vrátivší se klient dozví, co
 * zmeškal, a zahodit staré rámce znamená ztratit je **tiše**, bez toho, že by
 * se o mezeře dozvěděl.
 */
export function createEventLog(sessionId: string, options: EventLogOptions = {}): SessionEventLog {
  const now = options.now ?? (() => new Date().toISOString());
  const entries: LoggedEvent[] = [];
  const listeners = new Set<(event: SessionEvent) => void>();
  let sequence = options.startAt ?? 0;

  function publish(event: SessionEvent): SessionEvent {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
    return event;
  }

  return {
    get sequence() {
      return sequence;
    },

    get length() {
      return entries.length;
    },

    get watchers() {
      return listeners.size;
    },

    append(type, payload, subject = '') {
      const tail = entries[entries.length - 1];

      if (
        tail !== undefined &&
        tail.event.type === type &&
        tail.subject === subject &&
        isCoalescable(type)
      ) {
        // Číslo zůstává. Klient, který ten rámec už dostal, o něj nepřijde;
        // dostane jen starší obsah téhož průběhu, což je přesně to, co
        // „progress rámce se smějí slučovat" povoluje. Autoritativní stav
        // stejně přichází snapshotem, ne průběhem.
        const merged: SessionEvent = { ...tail.event, at: now(), payload };
        tail.event = merged;
        return publish(merged);
      }

      sequence += 1;
      const event: SessionEvent = { sessionId, sequence, type, at: now(), payload };
      entries.push({ event, subject });
      return publish(event);
    },

    since(after) {
      return entries.filter((entry) => entry.event.sequence > after).map((entry) => entry.event);
    },

    all() {
      return entries.map((entry) => entry.event);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
