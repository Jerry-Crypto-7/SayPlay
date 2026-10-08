import Image from 'next/image';
import { Suspense } from 'react';

import { CreateGame } from '@/components/play/CreateGame';
import { FeaturedGame, FeedPager } from '@/components/play/FeedPager';
import { HIDE_FOR_RETURNING } from '@/components/play/FirstVisitHint';
import { HERO, SUBHEAD } from '@/components/play/starters';
import { PendingUpgradeCards } from '@/components/play/UpgradeBanner';

/** Poslední slovo nadpisu nese zvýraznění kitu („What do you want to **play?**“). */
const HERO_CUT = HERO.lastIndexOf(' ') + 1;

/**
 * `/play` – domov podle kitu Sayplay (P34 T3, `01-home@2x.png`): app bar
 * s logem (bez avataru, účty nejsou), jediná h1 a bublina pro větu, pod nimi
 * svislý feed hratelných her. Na desktopu stojí vpravo od pole doporučená
 * hra 16:9, feed je pod tím. Hra ve feedu je `<main>` sama, proto obal
 * stránky není `main`. `Suspense`: feed čte `?g=` přes `useSearchParams`
 * a statická stránka bez hranice by se celá vykreslila až v prohlížeči.
 */
export default function PlayPage() {
  return (
    <>
      <header className="sp-appbar play-appbar">
        <Image className="sp-appbar__logo" src="/brand/logo/logo-lockup.svg" alt="sayplay" width={107} height={30} priority unoptimized />
      </header>
      <div className="play-home">
        <div className="play-create">
          <h1 className="sp-display-l play-hero">
            {HERO.slice(0, HERO_CUT)}
            <span className="sp-highlight">{HERO.slice(HERO_CUT)}</span>
          </h1>
          <p className="play-subhead">{SUBHEAD}</p>
          <script dangerouslySetInnerHTML={{ __html: HIDE_FOR_RETURNING }} />
          <CreateGame />
          <PendingUpgradeCards />
        </div>
        <FeaturedGame />
      </div>
      <Suspense fallback={null}>
        <FeedPager />
      </Suspense>
    </>
  );
}
