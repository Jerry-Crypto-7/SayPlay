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

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { DraftFinalReason } from '@/app/api/play/_upgrade';

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
  'UNCHANGED',
  'NOT_PLAYABLE',
  'STORE_UNAVAILABLE',
  'NOT_FROM_SENTENCE',
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

/** Proč AI verze nevyšla – jedna věta pro hráče na každý důvod serveru. */
export const FINAL_REASON_TEXT: Readonly<Record<DraftFinalReason, string>> = {
  MODEL_UNAVAILABLE: 'The AI is busy right now – you are playing the quick version.',
  MALFORMED: 'The AI sent back an answer we could not read, so the quick version stays.',
  UNREPAIRED: 'The AI made a mistake it could not fix, so the quick version stays.',
  UNCHANGED: 'The AI had nothing to add – the quick version is already its take.',
  NOT_PLAYABLE: "The AI's version didn't pass our playability check.",
  STORE_UNAVAILABLE: 'We could not save the AI version right now.',
  NOT_FROM_SENTENCE: 'This game was not made from a sentence, so there is no AI version.',
  FAILED: 'Something went wrong while building the AI version.',
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

/** Co proužek řekne a nabídne; `null` = nic. Nejvýš jedna akce, žádná procenta. */
export function noticeOf(view: UpgradeView, now: number): UpgradeNotice | null {
  switch (view.kind) {
    case 'idle':
      return null;
    case 'working':
      return { text: `Your AI version is being built – keep playing, nothing will change until you choose. ${Math.max(0, Math.floor((now - view.since) / 1000))} s`, action: null };
    case 'ready':
      return { text: 'Your AI version is ready', action: { kind: 'open', label: 'Open it' } };
    case 'final':
      return { text: FINAL_REASON_TEXT[view.reason], action: RETRYABLE.has(view.reason) ? { kind: 'retry', label: 'Try again' } : null };
    case 'offline':
    case 'lost':
      return { text: 'We lost track of the AI – check again', action: { kind: 'retry', label: 'Check again' } };
  }
}

/** Proužek nad hrou pro každý stav AI verze. Rozehraná hra se nevymění – nová se otevře jen tlačítkem. */
export function UpgradeBanner({ request }: { readonly request: string | null }) {
  const router = useRouter();
  const { view, retry } = useUpgrade(request);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (view.kind !== 'working') return;
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(ticker);
  }, [view.kind]);

  const notice = noticeOf(view, Math.max(now, view.kind === 'working' ? view.since : now));
  if (notice === null) return null;
  const act = (): void => {
    if (view.kind === 'ready') router.push(`/play/${view.versionId}`);
    else retry();
  };
  return (
    <aside className="play-upgrade" data-testid="upgrade-state" data-kind={view.kind} role="status">
      <span>{notice.text}</span>
      {notice.action !== null && (
        <button className="play-button" type="button" data-testid="upgrade-action" onClick={act}>
          {notice.action.label}
        </button>
      )}
    </aside>
  );
}
