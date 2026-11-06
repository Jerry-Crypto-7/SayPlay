'use client';

/**
 * „How I read it“ na kartě startu (P73B T2): co hra z věty vzala – kdo jsi, proti komu, kde a jako
 * jaká hra se to hraje – a když hra něco nahradila, hned pod tím co (přeškrtnuté) a čím. Dřív to bylo
 * vidět jen v listu „About this game“ za pauzou. Fakta skládá server (`readFacts`), náhradu
 * `draft/unsupported.ts` (proužek `HonestyStrip`); tady se jen ukazují. Pod tím řádek „Checked“ (T3).
 */

import { type ReactNode, useEffect, useRef } from 'react';

import type { Honesty } from '@/play/draft/unsupported';

import { checkedLineOf } from './FairSheet';
import type { CheckFacts, ReadFacts } from './lab';
import { Icon } from './ui';

/** „You: cat · Against: seagulls · Place: city · Played as: chase“; bez hráče nebo soupeřů ta část chybí. */
export function readLineOf(read: Pick<ReadFacts, 'you' | 'against' | 'place' | 'game'>): string {
  return [
    read.you === null ? null : `You: ${read.you}`,
    read.against.length === 0 ? null : `Against: ${read.against.join(', ')}`,
    `Place: ${read.place}`,
    `Played as: ${read.game.toLowerCase()}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** „X isn't here yet – here's Y.“ (sloveso, P44C) a „The library isn't here yet – it's a spooky forest.“ (místo, P73A T5). */
const MISSING = /^(.+?) (?:isn't|aren't) here yet – (?:here's|it's) (.+?)\.?$/;
/** „Stab plays as a fight.“ – jedno sloveso; výčet víc sloves se ukáže celou větou. */
const PLAYED_AS = /^(\S+) plays as ([^,]+?)\.$/;

/**
 * Co věta chtěla a čím ho hra nahradila, z věty proužku náhrady. `null` = věta jiného tvaru
 * (žánr, který neumíme vůbec, věta bez slovesa) – karta ji pak ukáže celou.
 */
export function swapOf(reason: string): { readonly said: string; readonly instead: string } | null {
  const match = MISSING.exec(reason) ?? PLAYED_AS.exec(reason);
  return match === null ? null : { said: match[1]!, instead: match[2]! };
}

/**
 * Řádek „Checked“ (P73B T3): co brána ověřila; klepnutí otevře „Why this game is fair“. Karta startu dotek
 * propouští na scénu, tenhle řádek ne: `data-keeps-waiting` drží hodiny (`keepsWaiting`) a zastavené bublání
 * nepustí ťuk do gest scény – jinak by se zapsal jako první skok.
 */
export function CheckedLine({ checks, lose, onOpen }: { readonly checks: CheckFacts; readonly lose: string | null; readonly onOpen: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: Event) => event.stopPropagation();
    element.addEventListener('pointerdown', stop);
    element.addEventListener('keydown', stop);
    return () => {
      element.removeEventListener('pointerdown', stop);
      element.removeEventListener('keydown', stop);
    };
  }, []);
  return (
    <button ref={button} type="button" className="play-start-checked" data-testid="play-start-checked" data-keeps-waiting="" aria-haspopup="dialog" onClick={onOpen}>
      <Icon name="check" />
      {checkedLineOf(checks, lose)}
    </button>
  );
}

export function StartRead({ read, honesty = null, children }: { readonly read: ReadFacts; readonly honesty?: Honesty | null; readonly children?: ReactNode }) {
  const swap = honesty === null ? null : swapOf(honesty.reason);
  return (
    <div className="play-start-read" data-testid="play-start-read">
      <p className="play-start-read-title">How I read it</p>
      <p className="play-start-read-line" data-testid="play-start-read-line">
        {readLineOf(read)}
      </p>
      {honesty !== null && (
        <p className="play-start-read-swap" data-testid="play-start-read-swap">
          {swap === null ? (
            honesty.reason
          ) : (
            <>
              <s>{swap.said}</s> {swap.instead}
            </>
          )}
        </p>
      )}
      {children}
    </div>
  );
}
