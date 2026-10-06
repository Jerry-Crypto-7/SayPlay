'use client';

/**
 * Poctivá hláška nad hrou (P25E T2): věta chtěla hru, kterou neumíme, a hráč
 * dostal nejbližší, kterou umíme. Proužek to řekne a jde zavřít; hra pod ním
 * běží dál. Počítá ho stránka z věty (`unsupportedGame`), shell ho jen ukáže.
 */

import { useState } from 'react';

import type { Honesty } from '@/play/draft/unsupported';

export function HonestyStrip({ honesty }: { readonly honesty: Honesty }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <aside className="play-honest" data-testid="play-honest" role="status">
      {honesty.kind === 'no_verb' || honesty.kind === 'actions' ? (
        // P28D T4: věta hru nechtěla – hláška řekne, co se hraje a jak větu napsat příště.
        <p className="play-honest-text">
          <strong data-testid="play-honest-reason">{honesty.reason}</strong>
        </p>
      ) : (
        <p className="play-honest-text">
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
