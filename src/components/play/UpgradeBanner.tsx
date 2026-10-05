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
  | { readonly kind: 'working'; readonly since: number; readonly deadlineAt: number }
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
  'UNCHANGED',
  'NOT_PLAYABLE',
  'STORE_UNAVAILABLE',
  'NOT_FROM_SENTENCE',
  'BLOCKED',
  'FAILED',
]);

type Answer = { readonly status: 'pending'; readonly deadlineAt: number | null } | { readonly status: 'ready'; readonly versionId: string } | { readonly status: 'final'; readonly reason: DraftFinalReason };

/** Odpověď serveru, nebo `null`, když se jí nedá rozumět (počítá se jako chyba). */
function answerOf(body: unknown): Answer | null {
  if (typeof body !== 'object' || body === null) return null;
  const { status, versionId, reason, deadlineAt } = body as Record<string, unknown>;
  if (status === 'ready' && typeof versionId === 'string') return { status, versionId };
  if (status === 'draft-final') return { status: 'final', reason: typeof reason === 'string' && REASONS.has(reason) ? (reason as DraftFinalReason) : 'FAILED' };
  if (status === 'pending') {
    const deadline = typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : Number.NaN;
    return { status, deadlineAt: Number.isFinite(deadline) ? deadline : null };
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
    if ((answer.deadlineAt !== null && answer.deadlineAt !== deadlineAt) || recovered) {
      deadlineAt = answer.deadlineAt ?? deadlineAt;
      onView({ kind: 'working', since, deadlineAt });
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

/**
 * Proč AI verze nevyšla – jedna věta pro hráče na každý důvod serveru. Bez
 * obviňování (P33 T5): hráč slyší, co zůstává, ne čí je to chyba.
 */
export const FINAL_REASON_TEXT: Readonly<Record<DraftFinalReason, string>> = {
  MODEL_UNAVAILABLE: "Couldn't make the full-detail version right now. Keep playing the quick one.",
  MALFORMED: 'The full-detail version came back garbled. The quick one stays.',
  UNREPAIRED: "The full-detail version didn't pass our checks. The quick one stays.",
  VERB_UNPROVED: "The full-detail version's new move never worked in a test run. The quick one stays.",
  UNCHANGED: 'Nothing to add. The quick version already has it all.',
  NOT_PLAYABLE: "The full-detail version wasn't playable in a test run. The quick one stays.",
  STORE_UNAVAILABLE: "Couldn't save the full-detail version. The quick one stays.",
  NOT_FROM_SENTENCE: "This game wasn't made from an idea, so there's no full-detail version.",
  BLOCKED: "We can't show the full-detail version. The quick one stays.",
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
      return { text: QUICK_VERSION + QUICK_VERSION_REST, action: null };
    case 'ready':
      return { text: `${FULL_READY}${title === null ? '' : `: “${title}”`}`, action: { kind: 'open', label: PLAY_FULL } };
    case 'final':
      return { text: FINAL_REASON_TEXT[view.reason], action: RETRYABLE.has(view.reason) ? { kind: 'retry', label: 'Try again' } : null };
    case 'offline':
    case 'lost':
      return { text: 'We lost track of the full-detail version.', action: { kind: 'retry', label: 'Check again' } };
  }
}

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
 */
export function UpgradeBanner({ request, sentence, quick = null }: { readonly request: string | null; readonly sentence: string | null; readonly quick?: string | null }) {
  const router = useRouter();
  const { view, retry } = useUpgrade(request);
  const draftId = request === null ? null : draftIdOf(request);
  const since = view.kind === 'working' ? view.since : null;

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
  if (view.kind === 'working' || view.kind === 'ready') {
    const ready = view.kind === 'ready';
    return (
      <aside className="sp-status play-upgrade-status play-version-switch" data-testid="upgrade-state" data-kind={view.kind}>
        <span className="play-sr-only" role="status">
          {notice.text}
        </span>
        <span className="play-version-switch__item is-active" aria-current="true">
          {QUICK_LABEL}
        </span>
        <button type="button" className={ready ? 'play-version-switch__item is-ready' : 'play-version-switch__item'} data-testid="upgrade-action" disabled={!ready} title={notice.text} onClick={act}>
          {ready ? <Icon name="check" /> : <span className="sp-status__dot" aria-hidden="true" />}
          {FULL_LABEL}
        </button>
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
