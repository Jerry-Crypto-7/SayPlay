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

/** Stav AI verze návrhu na `url`; `url === null` = neptej se. Stav patří adrese, takže jiná hra nedostane cizí výsledek. */
export function useUpgrade(url: string | null): UpgradeView {
  const [state, setState] = useState<{ readonly url: string | null; readonly view: UpgradeView }>({ url: null, view: IDLE });

  useEffect(() => {
    if (url === null) return;
    return followUpgrade(url, (view) => setState({ url, view }));
  }, [url]);

  return url !== null && state.url === url ? state.view : IDLE;
}

export function UpgradeBanner({ versionId }: { readonly versionId: string }) {
  const router = useRouter();
  return (
    <aside className="play-upgrade" data-testid="play-upgrade" role="status">
      <span>Your custom version is ready</span>
      <button className="play-button" type="button" onClick={() => router.push(`/play/${versionId}`)}>
        Play it
      </button>
    </aside>
  );
}
