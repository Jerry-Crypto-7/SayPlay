import { Suspense } from 'react';

import { CreateGame } from '@/components/play/CreateGame';
import { FeedPager } from '@/components/play/FeedPager';
import { HERO, SUBHEAD } from '@/components/play/starters';
import { PendingUpgradeCards } from '@/components/play/UpgradeBanner';
import { ARCHETYPES } from '@/play/registry';

/** Věty archetypů pro seznam feedu – registr zůstává na serveru. */
const PITCHES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(ARCHETYPES).map(([id, archetype]) => [id, archetype.pitch]));

/**
 * `/play` – nahoře věta dovnitř (bez účtu), pod ní svislý feed hratelných her
 * (P27B T4). Hra ve feedu je `<main>` sama, proto obal stránky není `main`.
 * `Suspense`: feed čte `?g=` přes `useSearchParams` a statická stránka bez
 * hranice by se celá vykreslila až v prohlížeči.
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
        <FeedPager pitches={PITCHES} />
      </Suspense>
    </>
  );
}
