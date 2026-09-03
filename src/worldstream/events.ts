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
 * **Jediný `shape.refining`**, protože jediný z patnácti je průběh: říká, že
 * se na tvaru pracuje, a novější zpráva starší nahrazuje beze ztráty. Všechno
 * ostatní je stavový přechod a §20 tři z nich (`ready`, `failed`, `committed`)
 * jmenuje výslovně. Rozšiřovat tenhle seznam „pro jistotu" znamená mazat
 * přechody, které klientský reducer potřebuje vidět.
 */
export const COALESCABLE_EVENT_TYPES: readonly SessionEventType[] = ['shape.refining'];

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
 * rámců, ne desetitisíce, a jediné, co ten počet nafukuje, je průběh —
 * tedy právě to, co slučování shora omezuje.
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
