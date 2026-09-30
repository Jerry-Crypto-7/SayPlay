/**
 * „Quit“ na kartě pauzy (kit `08-game-hud.md`, P34 T5; dřív kolo „More“ v bočním
 * sloupci P33 T12): z hry na vlastní stránce zpět na `/play`. Ve feedu ho
 * shell nekreslí – hra tam leží přímo na `/play` a další nabízí pager.
 */

import Link from 'next/link';

import { Icon } from './ui';

export function MoreGames() {
  return (
    <Link href="/play" className="sp-btn sp-btn--s sp-btn--secondary play-quit" data-testid="play-more">
      <Icon name="close" />
      Quit
    </Link>
  );
}
