'use client';

/**
 * Poctivá hláška nad hrou (P25E T2): věta chtěla hru, kterou neumíme, a hráč
 * dostal nejbližší, kterou umíme. Proužek to řekne a jde zavřít; hra pod ním
 * běží dál. Počítá ho stránka z věty (`unsupportedGame`), shell ho jen ukáže.
 */

import { type KeyboardEvent, useState } from 'react';

import type { Honesty } from '@/play/draft/unsupported';

export function HonestyStrip({ honesty }: { readonly honesty: Honesty }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  if (!open) return null;
  const short = honesty.kind === 'no_verb' || honesty.kind === 'actions' || honesty.kind === 'played_as';
  // Proužek má jeden řádek s výpustkou (P56B T5); celý text je v `title` a klepnutí
  // ho rozbalí – `title` na dotyku nikdo neuvidí.
  const full = short ? honesty.reason : `This one isn't playable yet – here's the closest game we can build. ${honesty.reason} You're playing ${honesty.closest} instead.`;
  const toggle = {
    className: 'play-honest-text',
    title: full,
    role: 'button',
    tabIndex: 0,
    'aria-expanded': expanded,
    onClick: () => setExpanded((was) => !was),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setExpanded((was) => !was);
    },
  } as const;
  return (
    <aside className="play-honest" data-testid="play-honest" role="status">
      {short ? (
        // P28D T4: věta hru nechtěla – hláška řekne, co se hraje a jak větu napsat příště.
        <p {...toggle}>
          <strong data-testid="play-honest-reason">{honesty.reason}</strong>
        </p>
      ) : (
        <p {...toggle}>
          <strong>This one isn&apos;t playable yet – here&apos;s the closest game we can build.</strong>{' '}
          <span data-testid="play-honest-reason">
            {honesty.reason} You&apos;re playing {honesty.closest} instead.
          </span>
        </p>
      )}
      <button className="play-honest-close" type="button" onClick={() => setOpen(false)}>
        Got it
      </button>
    </aside>
  );
}
