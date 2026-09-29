/**
 * Jeden stav „hra se staví“ (P33 T14): od odeslání věty do první scény. Název
 * hry z věty, pozadí v tónu nálady, běžící pruh a `Building your game…`. Dřív
 * tu 300 ms po kliknutí stála tmavá stránka a kroky stavby pod polem.
 *
 * `title` chybí u scény, která jen dotahuje kód (`ArcadePlay`): název tam nese
 * pruh HUD nahoře a pod plátnem je obloha sady (P32D T6), proto bez pozadí.
 */

import type { ReactNode } from 'react';

import type { MoodTone } from '../Feed';

export function BuildingScreen({ title, tone, children }: { readonly title?: string; readonly tone?: MoodTone; readonly children?: ReactNode }) {
  return (
    <div className={title === undefined ? 'play-loading play-loading-stage' : 'play-loading'} data-testid="play-loading" data-tone={tone} aria-busy="true">
      {title !== undefined && <p className="play-loading-title">{title}</p>}
      <div className="play-loading-bar" aria-hidden="true">
        <span />
      </div>
      <p className="play-loading-text" role="status">
        Building your game…
      </p>
      {children}
    </div>
  );
}
