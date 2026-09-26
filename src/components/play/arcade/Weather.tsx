'use client';

/**
 * Počasí a denní doba živé změny (P29D T9) – CSS vrstva nad plátnem.
 *
 * Stav čte z logu živých změn (`visualAt`), ne ze stavu hry: vizuální patch
 * do hashe nesahá a replay ho přehraje z téhož logu. Začíná z `theme` hry –
 * sdílená verze s živými změnami (T10) tam nese svoje počasí. Jasno ve dne
 * nekreslí nic, takže hra bez počasí má stejný DOM jako dřív.
 */

import { useSyncExternalStore } from 'react';

import { HEADER } from '@/play/arcade/contract';
import { visualAt } from '@/play/arcade/live';
import type { GameSpecV1 } from '@/play/spec';

import type { ArcadeSession } from './session';

export function Weather({ session, theme }: { readonly session: ArcadeSession; readonly theme: GameSpecV1['theme'] }) {
  const start = `${theme.weather ?? 'clear'}|${theme.timeOfDay ?? 'day'}`;
  const key = useSyncExternalStore(
    session.subscribe,
    () => {
      const now = visualAt(session.patches(), session.state()[HEADER.tick] as number, theme);
      return `${now.weather}|${now.timeOfDay}`;
    },
    () => start,
  );
  const [weather, timeOfDay] = key.split('|');
  if (weather === 'clear' && timeOfDay === 'day') return null;
  return <div className="play-weather" data-testid="play-weather" data-weather={weather} data-time={timeOfDay} aria-hidden="true" />;
}
