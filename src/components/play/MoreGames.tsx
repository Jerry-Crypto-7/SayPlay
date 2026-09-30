/**
 * „More“ v bočním sloupci (P33 T12): z hry na vlastní stránce do feedu. Ve
 * feedu ho shell nekreslí – tam listuje pager.
 */

import Link from 'next/link';

import { Icon } from './ui';

export function MoreGames() {
  return (
    <Link href="/play" className="play-icon-button" data-testid="play-more" aria-label="More games">
      <span className="sp-btn sp-btn--icon play-icon-button-disc">
        <Icon name="arrow-right" />
      </span>
      <span className="play-icon-button-caption">More</span>
    </Link>
  );
}
