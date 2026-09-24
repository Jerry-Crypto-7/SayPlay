'use client';

/**
 * „Change it“ pod čipy (P27C T5): hráč napíše vlastní změnu a dostane novou
 * verzi s vlastním odkazem; rodič se nemění. Věta, kterou server pozná jako
 * čip, vrátí hned odkaz (201). Ostatní je práce na pozadí (202 `job`) – box
 * se ptá `GET …/remix?job=` do lhůty serveru a mluví stejně jako proužek AI
 * verze (uběhlé sekundy, žádná procenta). Nová verze se otevře jen tlačítkem.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { RemixFinalReason } from '@/app/api/play/_remix-jobs';

import { POLL_MS } from './UpgradeBanner';

/** Týž strop jako `MAX_REMIX_SENTENCE_CHARS` na serveru. */
const MAX_CHARS = 140;

type RemixView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly since: number }
  | { readonly kind: 'ready'; readonly versionId: string; readonly changed: readonly string[] }
  | { readonly kind: 'final'; readonly reason: RemixFinalReason }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'lost' };

const FINAL_TEXT: Readonly<Record<RemixFinalReason, string>> = {
  MODEL_UNAVAILABLE: 'The AI is busy right now.',
  MALFORMED: 'The AI sent back an answer we could not read.',
  UNREPAIRED: 'The AI made a mistake it could not fix.',
  UNCHANGED: 'The AI found nothing to change for that sentence.',
  NOT_PLAYABLE: "The changed game didn't pass our playability check.",
  STORE_UNAVAILABLE: 'We could not save the new version right now.',
  UNASKED_CHANGE: 'The AI changed more than you asked for, so your game stays as it is.',
  FAILED: 'Something went wrong while making the change.',
};

/** Výpadky, po kterých má nové odeslání smysl; ostatní jsou verdikt o větě (`TRANSIENT` v `_remix-jobs.ts`). */
const RETRYABLE: ReadonlySet<RemixFinalReason> = new Set(['MODEL_UNAVAILABLE', 'STORE_UNAVAILABLE', 'FAILED']);

/** Hotový stav práce, nebo `null` = ještě běží nebo odpovědi nejde rozumět. */
function outcomeOf(body: unknown): RemixView | null {
  if (typeof body !== 'object' || body === null) return null;
  const { status, versionId, changed, reason } = body as Record<string, unknown>;
  if (status === 'ready' && typeof versionId === 'string') {
    return { kind: 'ready', versionId, changed: Array.isArray(changed) ? changed.filter((line): line is string => typeof line === 'string') : [] };
  }
  if (status === 'final') return { kind: 'final', reason: typeof reason === 'string' && reason in FINAL_TEXT ? (reason as RemixFinalReason) : 'FAILED' };
  return null;
}

/** Ptá se na práci do `deadlineAt`; vrací zrušení. */
function followRemix(url: string, deadlineAt: number, onView: (view: RemixView) => void): () => void {
  const control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async (): Promise<void> => {
    let body: unknown = null;
    try {
      const response = await fetch(url, { signal: control.signal, cache: 'no-store' });
      if (response.ok) body = await response.json();
    } catch {
      // Výpadek sítě jen odloží další dotaz; zrušení ukončí smyčku níž.
    }
    if (control.signal.aborted) return;
    const outcome = outcomeOf(body);
    if (outcome !== null) return onView(outcome);
    if (Date.now() >= deadlineAt) return onView({ kind: 'lost' });
    timer = setTimeout(() => void ask(), POLL_MS);
  };
  timer = setTimeout(() => void ask(), POLL_MS);
  return () => {
    control.abort();
    clearTimeout(timer);
  };
}

export function RemixBox({ versionId }: { readonly versionId: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sent, setSent] = useState('');
  const [view, setView] = useState<RemixView>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  useEffect(() => {
    if (view.kind !== 'working') return;
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(ticker);
  }, [view.kind]);

  async function submit(sentence: string): Promise<void> {
    stop.current?.();
    stop.current = null;
    const since = Date.now();
    setSent(sentence);
    setNow(since);
    setView({ kind: 'working', since });
    const url = `/api/play/games/${versionId}/remix`;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
      const body = (await response.json()) as { job?: unknown; deadlineAt?: unknown; url?: unknown; error?: { message?: string } };
      if (response.status === 202 && typeof body.job === 'string') {
        const deadline = typeof body.deadlineAt === 'string' ? Date.parse(body.deadlineAt) : Number.NaN;
        stop.current = followRemix(`${url}?job=${body.job}`, Number.isFinite(deadline) ? deadline : since + 285_000, setView);
        return;
      }
      if (response.ok && typeof body.url === 'string') return router.push(body.url);
      setView({ kind: 'refused', message: body.error?.message ?? 'This change could not become a game.' });
    } catch {
      setView({ kind: 'refused', message: 'The change could not be sent. Check your connection and try again.' });
    }
  }

  const working = view.kind === 'working';
  const sentence = text.trim();
  return (
    <form
      className="play-remix"
      data-testid="remix-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (sentence.length > 0 && !working) void submit(sentence);
      }}
    >
      <div className="play-remix-row">
        <input
          className="play-remix-input"
          data-testid="remix-input"
          value={text}
          maxLength={MAX_CHARS}
          placeholder="Change it: add snow, make enemies faster…"
          aria-label="Change it in your own words"
          disabled={working}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="play-button" data-testid="remix-submit" disabled={working || sentence.length === 0}>
          Make it
        </button>
      </div>
      <span className="play-remix-count" data-testid="remix-count">
        {text.length}/{MAX_CHARS}
      </span>

      {view.kind !== 'idle' && (
        <div className="play-remix-state" data-testid="remix-state" data-kind={view.kind} role="status">
          {view.kind === 'working' && <p>Making your change – the original stays as it is. {Math.max(0, Math.floor((now - view.since) / 1000))} s</p>}
          {view.kind === 'ready' && (
            <>
              <p className="play-remix-changed-title">What changed</p>
              {view.changed.length > 0 && (
                <ul className="play-remix-changed" data-testid="remix-changed">
                  {view.changed.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <Link className="play-button" data-testid="remix-open" href={`/play/${view.versionId}`}>
                Play the new version
              </Link>
            </>
          )}
          {view.kind === 'final' && (
            <>
              <p>{FINAL_TEXT[view.reason]} Try one of the changes above instead.</p>
              {RETRYABLE.has(view.reason) && (
                <button type="button" className="play-button" data-testid="remix-retry" onClick={() => void submit(sent)}>
                  Try again
                </button>
              )}
            </>
          )}
          {view.kind === 'refused' && <p role="alert">{view.message}</p>}
          {view.kind === 'lost' && (
            <>
              <p>We lost track of the AI – check again.</p>
              <button type="button" className="play-button" data-testid="remix-retry" onClick={() => void submit(sent)}>
                Check again
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}
