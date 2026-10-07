'use client';

/**
 * Obsah listu „Change one thing“ (P27C T5; od P33 T4 v listu po hře, od P34 T7
 * podle vzoru `.sp-sheet` kitu): bublina `.sp-prompt` s popiskem „What should
 * change?“, počítadlem a mikrofonem, pod ní čipy návrhů `.sp-chip` a rajčatové
 * „Remix it“. Hráč napíše vlastní změnu a dostane novou verzi s vlastním
 * odkazem; rodič se nemění. Věta, kterou server pozná jako čip, vrátí hned
 * odkaz (201). Ostatní je práce na pozadí (202 `job`) – box se ptá
 * `GET …/remix?job=` do lhůty serveru a mluví stejně jako proužek AI verze
 * (uběhlé sekundy, žádná procenta). Nová verze se otevře jen tlačítkem.
 * Enter odešle, Shift+Enter zalomí řádek (kit `05-layout.md`).
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';

import type { RemixFinalReason } from '@/app/api/play/_remix-jobs';

import { appendSpoken, MicButton } from './MicButton';
import { COUNTER_WARN, REMIX_IT, REMIX_LABEL, REMIX_PLACEHOLDER } from './starters';
import { Button } from './ui';
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
  MODEL_UNAVAILABLE: "Couldn't remix it right now. Try again in a minute.",
  MALFORMED: "Couldn't read that remix back. Try again.",
  UNREPAIRED: "Couldn't build that change. Try a simpler one.",
  UNCHANGED: 'Nothing to change for that idea. Try saying it another way.',
  NOT_PLAYABLE: 'That change made the game unplayable. Try a different one.',
  STORE_UNAVAILABLE: "Couldn't save the remix right now. Try again.",
  UNASKED_CHANGE: 'That remix changed more than you asked, so your game stays as it is.',
  FAILED: "Couldn't make that change. Try again.",
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

export interface RemixJob {
  readonly versionId?: string;
  readonly view: RemixView;
  readonly sent: string;
  submit(sentence: string): void;
}

/**
 * Práce remixu patří obrazovce hry, ne boxu (P28B T7): Replay box odpojí,
 * práce ale běží dál a hotová verze se během hraní ukáže čipem
 * (`RemixReadyChip`). `showing` = obrazovka po hře je vidět – jen tehdy smí
 * okamžitá odpověď (201) přejít na novou verzi sama.
 */
export function useRemixJob(versionId: string, showing: boolean): RemixJob {
  const router = useRouter();
  const [sent, setSent] = useState('');
  const [view, setView] = useState<RemixView>({ kind: 'idle' });
  const stop = useRef<(() => void) | null>(null);
  const shown = useRef(showing);
  useEffect(() => {
    shown.current = showing;
  }, [showing]);

  useEffect(() => () => stop.current?.(), []);

  const submit = useCallback(
    async (sentence: string): Promise<void> => {
      stop.current?.();
      const control = new AbortController();
      stop.current = () => control.abort();
      const since = Date.now();
      setSent(sentence);
      setView({ kind: 'working', since });
      const url = `/api/play/games/${versionId}/remix`;
      try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }), signal: control.signal });
        const body = (await response.json()) as { job?: unknown; deadlineAt?: unknown; url?: unknown; error?: { message?: string } };
        if (control.signal.aborted) return;
        if (response.status === 202 && typeof body.job === 'string') {
          const deadline = typeof body.deadlineAt === 'string' ? Date.parse(body.deadlineAt) : Number.NaN;
          stop.current = followRemix(`${url}?job=${body.job}`, Number.isFinite(deadline) ? deadline : since + 285_000, setView);
          return;
        }
        if (response.ok && typeof body.url === 'string') {
          if (shown.current) return router.push(body.url);
          return setView({ kind: 'ready', versionId: body.url.split('/').at(-1) ?? '', changed: [] });
        }
        setView({ kind: 'refused', message: body.error?.message ?? 'This change could not become a game.' });
      } catch {
        if (!control.signal.aborted) setView({ kind: 'refused', message: 'The change could not be sent. Check your connection and try again.' });
      }
    },
    [versionId, router],
  );

  return { versionId, view, sent, submit: (sentence) => void submit(sentence) };
}

/** Remix dorazil během hraní: nabídka místo přesměrování uprostřed běhu. */
export function RemixReadyChip({ job }: { readonly job: RemixJob }) {
  if (job.view.kind !== 'ready') return null;
  return (
    <aside className="play-upgrade" data-testid="remix-ready" role="status">
      <span>Your remix is ready</span>
      <Link className="play-button" data-testid="remix-ready-open" href={`/play/${job.view.versionId}`}>
        Play it
      </Link>
    </aside>
  );
}

/** `suggestions` = čipy karty po hře (P33 T4), mezi polem a stavem – hláška „Try one of the changes above“ na ně ukazuje. */
export interface RecipeRemixChip {
  readonly id: string;
  readonly label: string;
  readonly cellId: string;
}

/** Only small, server-verified summaries cross the client boundary. */
export function RecipeRemixChips({ chips, submit, disabled }: {
  readonly chips: readonly RecipeRemixChip[];
  readonly submit: (sentence: string) => void;
  readonly disabled: boolean;
}) {
  if (chips.length === 0) return null;
  return <div className="play-remix-chips" aria-label="Add a mechanic">
    {chips.map(chip => <button key={chip.id} type="button" className="sp-chip" data-testid="recipe-remix-chip" data-cell={chip.cellId} disabled={disabled} onClick={() => submit(chip.label)}>{chip.label}</button>)}
  </div>;
}
export function RemixBox({ job, suggestions }: { readonly job: RemixJob; readonly suggestions?: ReactNode }) {
  const { view, sent, submit } = job;
  const form = useRef<HTMLFormElement | null>(null);
  const fieldId = useId();
  const [text, setText] = useState('');
  const [recipeChips, setRecipeChips] = useState<readonly RecipeRemixChip[]>([]);
  useEffect(() => {
    setRecipeChips([]);
    if (job.versionId === undefined) return;
    const control = new AbortController();
    void fetch(`/api/play/games/${job.versionId}/remix?suggestions=1`, { signal: control.signal, cache: 'no-store' })
      .then(async response => response.ok ? response.json() as Promise<{ suggestions?: unknown }> : null)
      .then(body => {
        if (control.signal.aborted || !Array.isArray(body?.suggestions)) return;
        setRecipeChips(body.suggestions.filter((item): item is RecipeRemixChip => typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.cellId === 'string').slice(0, 3));
      })
      .catch(() => { /* Existing free-form remix remains usable during a failed fetch. */ });
    return () => control.abort();
  }, [job.versionId]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (view.kind !== 'working') return;
    setNow(Date.now());
    const ticker = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(ticker);
  }, [view.kind]);

  const working = view.kind === 'working';
  const sentence = text.trim();
  return (
    <form
      ref={form}
      className="play-remix"
      data-testid="remix-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (sentence.length > 0 && !working) void submit(sentence);
      }}
    >
      <div className="sp-prompt play-remix-prompt">
        <label className="sp-prompt__label" htmlFor={fieldId}>
          {REMIX_LABEL}
        </label>
        <textarea
          id={fieldId}
          className="sp-prompt__field play-remix-input"
          data-testid="remix-input"
          rows={2}
          value={text}
          maxLength={MAX_CHARS}
          placeholder={REMIX_PLACEHOLDER}
          disabled={working}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            form.current?.requestSubmit();
          }}
        />
        <div className="sp-prompt__actions">
          <span className="sp-prompt__count" data-testid="remix-count" data-warn={text.length >= COUNTER_WARN ? 'true' : 'false'} aria-live="polite">
            {text.length}/{MAX_CHARS}
          </span>
          <MicButton
            testId="remix-mic"
            className="sp-btn sp-btn--icon sp-btn--sun play-mic"
            disabled={working}
            onText={(spoken) => setText((previous) => appendSpoken(previous, spoken).slice(0, MAX_CHARS))}
          />
        </div>
      </div>
      {recipeChips.length > 0 ? <RecipeRemixChips chips={recipeChips} submit={submit} disabled={working} /> : suggestions}
      <Button size="l" type="submit" className="sp-btn--block" data-testid="remix-submit" disabled={working || sentence.length === 0}>
        {REMIX_IT}
      </Button>

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
              <p>We lost track of your remix. Check again.</p>
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
