'use client';

/**
 * Změna běžící hry větou nebo hlasem (P29D T9).
 *
 * Tlačítko „Change“ (nebo Enter mimo pole, kde Enter nestřílí) otevře pole;
 * hra běží dál – klávesy psané do pole si hra nevezme (`isTyping`). Věta jde
 * přes `liveIntentOf`: živá změna se hned zapíše do relace (`session.live`),
 * co živě nejde, spustí dnešní remix na novou verzi a hotovou verzi ukáže
 * čip `remix-ready`. Nesmysl dostane poctivé „nerozumím“ s příklady.
 */

import { useEffect, useRef, useState } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { REMIX_MESSAGE, liveIntentOf, resolveWish } from '@/play/director/live-intent';
import type { GameSpecV1 } from '@/play/spec';

import { MicButton, appendSpoken } from '../MicButton';
import type { RemixJob } from '../RemixBox';
import { isTyping } from './input';
import type { ArcadeSession } from './session';

const MAX_CHARS = 160;

/** Ovládání, jejichž scéna bere Enter jako akci (`TimingScene` `TAP_KEYS`, `DuelScene` `STRIKE_KEYS`). */
const ENTER_ACTS = new Set(['timing', 'duel']);

/** Smí Enter otevřít pole? Ne tam, kde Enter hraje – úder by padl a pole by hráči sebralo klávesy. */
export function enterOpensLiveBox(world: ArcadeWorld): boolean {
  return !ENTER_ACTS.has(baseControlOf(world.control).id) && !world.rules.some((rule) => rule.id === 'blaster');
}

type Status = { readonly kind: 'live' | 'remix' | 'refused' | 'unknown'; readonly message: string };

/**
 * Tlačítko „Change“ je od P33 T12 kolo v bočním sloupci hry (`ArcadePlay`),
 * proto je otevření řízené zvenku; tady zůstává pole a stav poslední změny.
 */
export function LiveBox({
  session,
  spec,
  remix,
  enterOpens,
  open,
  setOpen,
}: {
  readonly session: ArcadeSession;
  readonly spec: GameSpecV1;
  readonly remix: RemixJob;
  readonly enterOpens: boolean;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!enterOpens || open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enterOpens, open, setOpen]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function apply(sentence: string): Status {
    const intent = liveIntentOf(sentence, spec);
    if (intent.kind === 'unknown') return { kind: 'unknown', message: intent.message };
    if (intent.kind === 'needsRemix') {
      remix.submit(sentence);
      return { kind: 'remix', message: REMIX_MESSAGE };
    }
    // Nejdřív všechno přeložit, pak zapsat: věta, kterou hra celou neunese, nesmí půlku změnit a hlásit odmítnutí.
    const patches = intent.wishes.map((wish) => resolveWish(wish, session.state()));
    if (patches.some((patch) => patch === null)) return { kind: 'refused', message: 'This game has nothing like that to add.' };
    let applied = 0;
    for (const patch of patches) {
      const problem = session.live(patch!);
      // Robot může odmítnout až pozdější změnu – co už platí, se hlásí jako hotové, jinak by nové odeslání zdvojilo.
      if (problem !== null) return applied === 0 ? { kind: 'refused', message: problem } : { kind: 'live', message: `Done in part. ${problem}` };
      applied += 1;
    }
    return { kind: 'live', message: `Done: ${sentence}` };
  }

  if (!open) {
    if (status === null) return null;
    return (
      <div className="play-live">
        <p className="play-live-status" data-testid="live-status" data-kind={status.kind} role="status">
          {status.message}
        </p>
      </div>
    );
  }

  const sentence = text.trim();
  return (
    <form
      className="play-live"
      data-testid="live-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (sentence.length === 0) return;
        const next = apply(sentence);
        setStatus(next);
        if (next.kind === 'live' || next.kind === 'remix') {
          setText('');
          setOpen(false);
        }
      }}
    >
      <div className="play-live-row">
        <input
          ref={input}
          className="play-live-input"
          data-testid="live-input"
          value={text}
          maxLength={MAX_CHARS}
          placeholder="More enemies, make it rain, extra life…"
          aria-label="Change the running game"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        <MicButton testId="live-mic" onText={(spoken) => setText((previous) => appendSpoken(previous, spoken).slice(0, MAX_CHARS))} />
        <button type="submit" className="play-button" data-testid="live-submit" disabled={sentence.length === 0}>
          Change
        </button>
      </div>
      {status !== null && (
        <p className="play-live-status" data-testid="live-status" data-kind={status.kind} role="status">
          {status.message}
        </p>
      )}
    </form>
  );
}
