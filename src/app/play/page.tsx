import { Suspense } from 'react';

import { CreateGame } from '@/components/play/CreateGame';
import { FeedPager } from '@/components/play/FeedPager';
import { HERO, SUBHEAD } from '@/components/play/starters';
import { PendingUpgradeCards } from '@/components/play/UpgradeBanner';

/**
 * `/play` – nahoře jediná h1 a věta dovnitř (bez účtu), pod nimi svislý feed
 * hratelných her (P27B T4; bez feedu ukázková hra, P28D T7). Pole je jádro
 * produktu, proto stojí první na telefonu i na desktopu (P33 T13); ve feedu
 * k němu vede plovoucí `+ New game`. Hra ve feedu je `<main>` sama, proto obal
 * stránky není `main`. `Suspense`: feed čte `?g=` přes `useSearchParams` a
 * statická stránka bez hranice by se celá vykreslila až v prohlížeči.
 */
export default function PlayPage() {
  return (
    <>
      <div className="play-create">
        <h1 className="play-hero">{HERO}</h1>
        <p className="play-subhead">{SUBHEAD}</p>
        <CreateGame />
        <PendingUpgradeCards />
      </div>
      <Suspense fallback={null}>
        <FeedPager />
      </Suspense>
    </>
  );
}
