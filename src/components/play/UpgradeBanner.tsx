'use client';

/**
 * Proužek progresivní hry (P23-D T2): návrh ze slov se hraje hned a server
 * mezitím dopočítá autorskou verzi. Rozehraná hra se **nepřepíná sama** –
 * přejde se až tlačítkem.
 *
 * P27C T1: hook vrací rozlišený stav (`UpgradeView`) a ptá se `GET …/upgrade`
 * do lhůty, kterou řekne server (`deadlineAt`), ne do pevných 90 s – režie
 * smí trvat až 270 s a pozdní hotová verze se dřív ztratila potichu.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { DraftFinalReason } from '@/app/api/play/_upgrade';

import { forgetPending, type PendingUpgrade, pendingUpgrades, rememberPending } from './pending-upgrades';
import { FULL_LABEL, FULL_READY, PLAY_FULL, QUICK_LABEL, QUICK_VERSION, QUICK_VERSION_REST } from './starters';
import { Button, Icon } from './ui';

export type UpgradeView =
  | { readonly kind: 'idle' }
  // `reading` (P58D T3): id hry ze čtení – jiný žánr než rychlá hra, hraje se, než dorazí AI verze.
  | { readonly kind: 'working'; readonly since: number; readonly deadlineAt: number; readonly queued?: number; readonly reading?: string }
  | { readonly kind: 'ready'; readonly versionId: string }
  | { readonly kind: 'final'; readonly reason: DraftFinalReason }
  | { readonly kind: 'offline' }
  | { readonly kind: 'lost' };

export const POLL_MS = 2_000;
/** Po `OFFLINE_AFTER` chybách po sobě se ptá řidčeji – síť nebo server právě nejsou. */
export const OFFLINE_POLL_MS = 10_000;
export const OFFLINE_AFTER = 3;
/** Lhůta, než první `pending` řekne skutečnou: rozpočet režie + rezerva (`pendingSince` v `_upgrade.ts`). */
export const PROVISIONAL_DEADLINE_MS = 285_000;

const IDLE: UpgradeView = { kind: 'idle' };

const REASONS: ReadonlySet<string> = new Set<DraftFinalReason>([
  'MODEL_UNAVAILABLE',
  'MALFORMED',
  'UNREPAIRED',
  'VERB_UNPROVED',
  'ACTION_LOST',
  'UNCHANGED',
  'NOT_PLAYABLE',
  'STORE_UNAVAILABLE',
  'NOT_FROM_SENTENCE',
  'BLOCKED',
  'FAILED',
]);

type Answer =
  | { readonly status: 'pending'; readonly deadlineAt: number | null; readonly queued: number | null; readonly reading: string | null }
  | { readonly status: 'ready'; readonly versionId: string }
  | { readonly status: 'final'; readonly reason: DraftFinalReason };

/** `pending.reading.versionId` (P58D T2) jako id hry, jinak `null` – adresa z něj vznikne, tak jen tvar id. */
function readingOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const { versionId } = value as Record<string, unknown>;
  return typeof versionId === 'string' && /^[a-f0-9]{8,64}$/.test(versionId) ? versionId : null;
}

/** `queued` ze stavu `pending` (P53 T3): pořadí ve frontě režiséra od 1, cokoli jiného `null` = nečeká. */
export function queuedOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** Pořadí ve frontě slovy, pro pilulku i pro remix: „next“ / „#3“. */
export function placeInLine(queued: number): string {
  return queued === 1 ? 'next' : `#${String(queued)}`;
}

/** Odpověď serveru, nebo `null`, když se jí nedá rozumět (počítá se jako chyba). */
function answerOf(body: unknown): Answer | null {
  if (typeof body !== 'object' || body === null) return null;
  const { status, versionId, reason, deadlineAt, queued, reading } = body as Record<string, unknown>;
  if (status === 'ready' && typeof versionId === 'string') return { status, versionId };
  if (status === 'draft-final') return { status: 'final', reason: typeof reason === 'string' && REASONS.has(reason) ? (reason as DraftFinalReason) : 'FAILED' };
  if (status === 'pending') {
    const deadline = typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : Number.NaN;
    return { status, deadlineAt: Number.isFinite(deadline) ? deadline : null, queued: queuedOf(queued), reading: readingOf(reading) };
  }
  return null;
}

/**
 * Sleduje jednu práci, dokud neskončí nebo nevyprší lhůta; vrací zrušení.
 * `onView` dostane jen změny stavu – každé `pending` hru nepřekresluje.
 */
export function followUpgrade(url: string, onView: (view: UpgradeView) => void): () => void {
  const control = new AbortController();
  const since = Date.now();
  let deadlineAt = since + PROVISIONAL_DEADLINE_MS;
  let queued: number | null = null;
  let reading: string | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = (delay: number): void => {
    if (Date.now() >= deadlineAt) {
      onView({ kind: 'lost' });
      return;
    }
    timer = setTimeout(() => void ask(), delay);
  };

  const ask = async (): Promise<void> => {
    let body: unknown = null;
    try {
      const response = await fetch(url, { signal: control.signal, cache: 'no-store' });
      if (response.ok) body = await response.json();
    } catch {
      // Výpadek sítě je chyba jako každá jiná; zrušení ne.
    }
    if (control.signal.aborted) return;

    const answer = answerOf(body);
    if (answer === null) {
      failures += 1;
      if (failures === OFFLINE_AFTER) onView({ kind: 'offline' });
      later(failures >= OFFLINE_AFTER ? OFFLINE_POLL_MS : POLL_MS);
      return;
    }
    const recovered = failures >= OFFLINE_AFTER;
    failures = 0;
    if (answer.status === 'ready') return onView({ kind: 'ready', versionId: answer.versionId });
    if (answer.status === 'final') return onView({ kind: 'final', reason: answer.reason });
    // Hra ze čtení jednou známá se nezapomene – pozdější `pending` bez ní je jiná instance, ne zrušení.
    const known = answer.reading ?? reading;
    if ((answer.deadlineAt !== null && answer.deadlineAt !== deadlineAt) || answer.queued !== queued || known !== reading || recovered) {
      deadlineAt = answer.deadlineAt ?? deadlineAt;
      queued = answer.queued;
      reading = known;
      onView({ kind: 'working', since, deadlineAt, ...(queued === null ? {} : { queued }), ...(reading === null ? {} : { reading }) });
    }
    later(POLL_MS);
  };

  onView({ kind: 'working', since, deadlineAt });
  timer = setTimeout(() => void ask(), POLL_MS);
  return () => {
    control.abort();
    clearTimeout(timer);
  };
}

/**
 * Stav AI verze návrhu na `url`; `url === null` = neptej se. Stav patří adrese,
 * takže jiná hra nedostane cizí výsledek. `retry` začne sledovat znovu – první
 * dotaz na `…/upgrade` po přechodném konci spustí nový pokus a souběžný se
 * na serveru spáruje s běžící prací (`upgradeOf`), takže dvojí klik nezaplatí dvakrát.
 */
export function useUpgrade(url: string | null): { readonly view: UpgradeView; readonly retry: () => void } {
  const [state, setState] = useState<{ readonly url: string | null; readonly view: UpgradeView }>({ url: null, view: IDLE });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (url === null) return;
    return followUpgrade(url, (view) => setState({ url, view }));
  }, [url, attempt]);

  return { view: url !== null && state.url === url ? state.view : IDLE, retry: () => setAttempt((count) => count + 1) };
}

/** Hraje-li hráč aspoň tolik, hra ze čtení ho už nepřepne sama, jen se nabídne (P58D T3). */
export const COMMITTED_MS = 6_000;
export const MATCHED_LABEL = 'Matched';
export const MATCHED_NOTE = 'Matched your idea';
const MATCHED_OFFER = 'A game that matches your idea is ready';

/** Hráč se do hry pustil: hraje aspoň `COMMITTED_MS`, nebo běh skončil (výhra i prohra). */
export function committedNow(seconds: number, ended: boolean): boolean {
  return ended || seconds * 1000 >= COMMITTED_MS;
}

/** `committedNow`, který drží: hra spuštěná znovu po prohře hráče zase „nerozehraje“. */
export function useCommitted(seconds: number, ended: boolean): boolean {
  const now = committedNow(seconds, ended);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (now) setHeld(true);
  }, [now]);
  return held || now;
}

/**
 * Hry ze čtení, na které už stránka sama přešla (P58D T3). Klientská navigace modul nenačte znovu, takže hráč, který se
 * tlačítkem Quick vrátil na rychlou hru, už jen dostane nabídku; `arrivals` řekne stránce hry ze čtení, že má ohlásit
 * příchod. Plné načtení stránky obojí zapomene – a hráč znovu dostane hru podle čtení.
 */
const switched = new Set<string>();
const arrivals = new Set<string>();

/** Co udělat s hrou ze čtení na stránce hry `versionId`: přejít, nabídnout, nebo nic. */
export function readingMove(view: UpgradeView, versionId: string | null, committed: boolean, switchedBefore: ReadonlySet<string> = switched): { readonly kind: 'switch' | 'offer'; readonly versionId: string } | null {
  if (view.kind !== 'working' || view.reading === undefined || view.reading === versionId) return null;
  return { kind: committed || switchedBefore.has(view.reading) ? 'offer' : 'switch', versionId: view.reading };
}

/**
 * Proč AI verze nevyšla – jedna věta pro hráče na každý důvod serveru. Bez
 * obviňování (P33 T5): hráč slyší, co zůstává, ne čí je to chyba.
 */
export const FINAL_REASON_TEXT: Readonly<Record<DraftFinalReason, string>> = {
  MODEL_UNAVAILABLE: "Couldn't make the full-detail version right now. Keep playing the quick one.",
  MALFORMED: 'The full-detail version came back garbled. The quick one stays.',
  UNREPAIRED: "The full-detail version didn't pass our checks. The quick one stays.",
  VERB_UNPROVED: "The full-detail version's new move never worked in a test run. The quick one stays.",
  ACTION_LOST: "The full-detail version lost a move from your sentence. The quick one stays.",
  UNCHANGED: "The full-detail version didn't add more. Keep playing the quick one.",
  NOT_PLAYABLE: "The full-detail version wasn't playable in a test run. The quick one stays.",
  STORE_UNAVAILABLE: "Couldn't save the full-detail version. The quick one stays.",
  NOT_FROM_SENTENCE: "This game wasn't made from an idea, so there's no full-detail version.",
  BLOCKED: "We can't show the full-detail version. The quick one stays.",
  CHAIN: "This game is a run of rounds, so there's no full-detail version.",
  FAILED: "Couldn't finish the full-detail version. The quick one stays.",
};

/**
 * Důvody, u kterých má nový pokus smysl: serverový `isTransient` (výpadek,
 * úložiště, chyba) bez `NOT_FROM_SENTENCE` – ten se opakováním nezmění.
 */
const RETRYABLE: ReadonlySet<DraftFinalReason> = new Set(['MODEL_UNAVAILABLE', 'STORE_UNAVAILABLE', 'FAILED']);

export interface UpgradeNotice {
  readonly text: string;
  readonly action: { readonly kind: 'open' | 'retry'; readonly label: string } | null;
  /** Krátký viditelný text v pilulce – jen pořadí ve frontě režiséra (P53 T3). */
  readonly note?: string;
}

/**
 * Co štítek řekne a nabídne; `null` = nic. Nejvýš jedna akce, žádná procenta
 * ani ubíhající sekundy – běh ukazuje pulzující tečka pilulky (kit: kromě ní
 * se nic nehýbe samo).
 */
export function noticeOf(view: UpgradeView, title: string | null = null): UpgradeNotice | null {
  switch (view.kind) {
    case 'idle':
      return null;
    case 'working':
      if (view.queued === undefined) return { text: QUICK_VERSION + QUICK_VERSION_REST, action: null };
      // Fronta (P53 T3) jen mění konec věty kitu: čekání ve frontě není chyba, rychlá verze se hraje dál.
      return { text: `${QUICK_VERSION} · the full-detail one is ${placeInLine(view.queued)} in line`, action: null, note: view.queued === 1 ? 'Next in line' : `${placeInLine(view.queued)} in line` };
    case 'ready':
      return { text: `${FULL_READY}${title === null ? '' : `: “${title}”`}`, action: { kind: 'open', label: PLAY_FULL } };
    case 'final':
      return { text: FINAL_REASON_TEXT[view.reason], action: RETRYABLE.has(view.reason) ? { kind: 'retry', label: 'Try again' } : null };
    case 'offline':
    case 'lost':
      return { text: 'We lost track of the full-detail version.', action: { kind: 'retry', label: 'Check again' } };
  }
}

/** Toast konce bez AI verze (P56B T5): 3 s jako `.sp-toast` kitu, pak jen tečka a akce v přepínači verze. */
export const TOAST_MS = 3_000;

function draftIdOf(request: string): string | null {
  return /\/games\/([^/]+)\/upgrade$/.exec(request)?.[1] ?? null;
}

/**
 * Přepínač Quick | Full detail nad hrou (P38, nahrazuje pilulku a toast P34 T4).
 * Je to `.sp-status` – inkoustová pilulka mimo sloupec akcí a řádku ovládání.
 * Na rychlé verzi svítí Quick; Full detail má během práce pulzující tečku
 * a je neaktivní, hotová verze ho rozsvítí a klepnutí ji otevře. Na AI verzi
 * (`quick` = id návrhu) svítí Full detail a Quick vede zpátky. Věta kitu jde
 * čtečce. Rozehraná hra se nevymění – přepne se jen klepnutím. Konec bez AI
 * verze zůstává malá poznámka na místě pilulky. Rozběhnutou práci si prohlížeč
 * zapamatuje (T3), `final` jen jednou ukáže a zapomene.
 *
 * P58D T3: hra ze čtení (`view.reading`) hraje žánr věty o minutu dřív než AI verze. Kdo ještě nehraje (`committed`),
 * přejde na ni sám (`router.replace`) a stránka ohlásí „Matched your idea“; rozehraná hra se nevymění, přepínač
 * nabídne Matched. Na hře ze čtení (`matchedOf` = rychlá hra) vede Quick zpátky a Full detail čeká dál.
 */
export function UpgradeBanner({
  request,
  sentence,
  quick = null,
  matchedOf = null,
  versionId = null,
  committed = false,
}: {
  readonly request: string | null;
  readonly sentence: string | null;
  readonly quick?: string | null;
  readonly matchedOf?: string | null;
  readonly versionId?: string | null;
  readonly committed?: boolean;
}) {
  const router = useRouter();
  const { view, retry } = useUpgrade(request);
  const move = readingMove(view, versionId, committed);
  const switchTo = move?.kind === 'switch' ? move.versionId : null;
  useEffect(() => {
    if (switchTo === null) return;
    switched.add(switchTo);
    arrivals.add(switchTo);
    router.replace(`/play/${switchTo}`);
  }, [switchTo, router]);
  // Na hru ze čtení se dá přijít i klepnutím na nabídku: návrat tlačítkem Quick pak taky jen nabízí, nepřepne zpátky.
  useEffect(() => {
    if (matchedOf !== null && versionId !== null) switched.add(versionId);
  }, [matchedOf, versionId]);
  const [matched, setMatched] = useState(false);
  useEffect(() => {
    if (versionId !== null && arrivals.delete(versionId)) setMatched(true);
  }, [versionId]);
  useEffect(() => {
    if (!matched) return;
    const timer = setTimeout(() => setMatched(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [matched]);
  const draftId = request === null ? null : draftIdOf(request);
  const since = view.kind === 'working' ? view.since : null;
  // Konec bez AI verze (P56B T5) je stav na pozadí, ne chyba hráče: toast `TOAST_MS`, pak se schová do přepínače verze.
  const [toasted, setToasted] = useState<UpgradeView | null>(null);
  useEffect(() => {
    if (view.kind !== 'final' && view.kind !== 'offline' && view.kind !== 'lost') return;
    const timer = setTimeout(() => setToasted(view), TOAST_MS);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (draftId === null) return;
    if (since !== null && sentence !== null) rememberPending({ draftId, sentence, startedAt: since });
    if (view.kind === 'final') forgetPending(draftId);
  }, [draftId, sentence, since, view.kind]);

  // Název AI verze (P28D T7): porotce má vědět, co se otevře; bez něj proužek nečeká.
  const readyId = view.kind === 'ready' ? view.versionId : null;
  const [title, setTitle] = useState<{ readonly id: string; readonly title: string } | null>(null);
  useEffect(() => {
    if (readyId === null) return;
    let live = true;
    fetch(`/api/play/games/${readyId}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ spec?: { title?: unknown } }>) : null))
      .then((body) => {
        if (live && typeof body?.spec?.title === 'string') setTitle({ id: readyId, title: body.spec.title });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [readyId]);

  if (quick !== null) {
    return (
      <aside className="sp-status play-upgrade-status play-version-switch" data-testid="upgrade-state" data-kind="full">
        <button type="button" className="play-version-switch__item" data-testid="version-quick" onClick={() => router.push(`/play/${quick}`)}>
          {QUICK_LABEL}
        </button>
        <span className="play-version-switch__item is-active" aria-current="true">
          {FULL_LABEL}
        </span>
      </aside>
    );
  }

  const notice = noticeOf(view, title !== null && title.id === readyId ? title.title : null);
  if (notice === null) return null;
  const act = (): void => {
    if (view.kind !== 'ready') return retry();
    if (draftId !== null) forgetPending(draftId);
    router.push(`/play/${view.versionId}`);
  };
  // Aktivní položka přepínače: na hře ze čtení Matched, jinde Quick.
  const current = (
    <span className="play-version-switch__item is-active" aria-current="true">
      {matchedOf === null ? QUICK_LABEL : MATCHED_LABEL}
    </span>
  );
  // Z hry ze čtení vede Quick zpátky i po konci bez AI verze.
  const backToQuick = matchedOf !== null && (
    <button type="button" className="play-version-switch__item" data-testid="version-quick" onClick={() => router.push(`/play/${matchedOf}`)}>
      {QUICK_LABEL}
    </button>
  );
  if (view.kind === 'working' || view.kind === 'ready') {
    const ready = view.kind === 'ready';
    const offer = move?.kind === 'offer' ? move.versionId : null;
    const text = matchedOf !== null && !ready ? MATCHED_NOTE + QUICK_VERSION_REST : notice.text;
    return (
      <aside className="sp-status play-upgrade-status play-version-switch" data-testid="upgrade-state" data-kind={view.kind} data-reading={matchedOf !== null ? 'current' : offer !== null ? 'offer' : undefined}>
        <span className="play-sr-only" role="status">
          {text}
        </span>
        {backToQuick}
        {current}
        {offer !== null && (
          <button type="button" className="play-version-switch__item is-ready" data-testid="reading-action" title={MATCHED_OFFER} onClick={() => router.push(`/play/${offer}`)}>
            <Icon name="check" />
            {MATCHED_LABEL}
          </button>
        )}
        <button type="button" className={ready ? 'play-version-switch__item is-ready' : 'play-version-switch__item'} data-testid="upgrade-action" disabled={!ready} title={text} onClick={act}>
          {ready ? <Icon name="check" /> : <span className="sp-status__dot" aria-hidden="true" />}
          {FULL_LABEL}
        </button>
        {matched ? (
          <span className="play-version-switch__note" data-testid="reading-matched" aria-hidden="true">
            {MATCHED_NOTE}
          </span>
        ) : (
          notice.note !== undefined && (
            <span className="play-version-switch__note" data-testid="upgrade-queued" aria-hidden="true">
              {notice.note}
            </span>
          )
        )}
      </aside>
    );
  }
  if (toasted === view) {
    return (
      <aside className="sp-status play-upgrade-status play-version-switch" data-testid="upgrade-state" data-kind={view.kind}>
        <span className="play-sr-only">{notice.text}</span>
        {backToQuick}
        {current}
        {notice.action !== null ? (
          <button type="button" className="play-version-switch__item" data-testid="upgrade-action" title={notice.text} onClick={act}>
            <span className="sp-status__dot play-version-switch__dot" aria-hidden="true" />
            {notice.action.label}
          </button>
        ) : (
          <span className="play-version-switch__item is-off" title={notice.text}>
            <span className="sp-status__dot play-version-switch__dot" aria-hidden="true" />
            {FULL_LABEL}
          </span>
        )}
      </aside>
    );
  }
  return (
    <aside className="sp-toast play-upgrade-toast play-upgrade-note" data-testid="upgrade-state" data-kind={view.kind} role="status">
      <span>{notice.text}</span>
      {notice.action !== null && (
        <Button variant="secondary" size="s" data-testid="upgrade-action" onClick={act}>
          {notice.action.label}
        </Button>
      )}
    </aside>
  );
}

type Settled = { readonly entry: PendingUpgrade; readonly answer: { readonly status: 'ready'; readonly versionId: string } | { readonly status: 'final'; readonly reason: DraftFinalReason } };

/**
 * Karty na `/play` (T3): uložené práce se jednou zeptají na stav. Hotová verze
 * dostane kartu s odkazem, neúspěch se ukáže jednou a zapomene, běžící mlčí.
 */
export function PendingUpgradeCards() {
  const [settled, setSettled] = useState<readonly Settled[]>([]);

  useEffect(() => {
    const control = new AbortController();
    for (const entry of pendingUpgrades()) {
      void fetch(`/api/play/games/${entry.draftId}/upgrade`, { signal: control.signal, cache: 'no-store' })
        .then(async (response) => {
          if (response.status === 404) return forgetPending(entry.draftId);
          const answer = response.ok ? answerOf(await response.json()) : null;
          if (answer === null || answer.status === 'pending') return;
          if (answer.status === 'final') forgetPending(entry.draftId);
          setSettled((shown) => [...shown.filter((known) => known.entry.draftId !== entry.draftId), { entry, answer }]);
        })
        .catch(() => {
          // Bez sítě karta prostě nebude; práce zůstane uložená na příště.
        });
    }
    return () => control.abort();
  }, []);

  if (settled.length === 0) return null;
  return (
    <ul className="play-pending">
      {settled.map(({ entry, answer }) => (
        <li key={entry.draftId} className="play-pending-card" data-testid="pending-upgrade" data-kind={answer.status}>
          {answer.status === 'ready' ? (
            <>
              <span>Your game &lsquo;{entry.sentence}&rsquo; is ready</span>
              <Link className="play-button" href={`/play/${answer.versionId}`} onClick={() => forgetPending(entry.draftId)}>
                Open it
              </Link>
            </>
          ) : (
            <span>
              Your game &lsquo;{entry.sentence}&rsquo;: {FINAL_REASON_TEXT[answer.reason]}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
