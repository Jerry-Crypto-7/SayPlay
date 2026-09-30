/**
 * Plovoucí lišta domova na telefonu (kit `.sp-tabbar`, P34 T3). Jen položky,
 * které produkt umí: **Make** skočí k poli, **Play** k feedu – účty ani profil
 * v produktu nejsou (`docs/brand/REPO-NOTES.md`). Aktivní je ta, jejíž část je
 * zrovna vidět (inkoustová pilulka). Během hry ve feedu ji schová CSS; na
 * desktopu není vůbec. Make nese `play-new-game` po plovoucím tlačítku P33.
 */

import { Icon } from './icons';

export type Tab = 'make' | 'play';

export function TabBar({ active, onMake, onPlay }: { readonly active: Tab; readonly onMake: () => void; readonly onPlay: () => void }) {
  const item = (tab: Tab) => ({
    type: 'button' as const,
    className: tab === active ? 'sp-tabbar__item is-active' : 'sp-tabbar__item',
    'aria-current': tab === active ? ('true' as const) : undefined,
  });
  return (
    <nav className="sp-tabbar play-tabbar" aria-label="Main" data-on={active}>
      <button {...item('make')} data-testid="play-new-game" onClick={onMake}>
        <Icon name="plus" />
        Make
      </button>
      <button {...item('play')} data-testid="play-tab-play" onClick={onPlay}>
        <Icon name="play" />
        Play
      </button>
    </nav>
  );
}
