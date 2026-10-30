import { createContext } from 'react';

import { shared } from '../xr/xr-context';

/** Přechod na další kartu feedu (P54A T9) – výsledek běhu ve feedu z něj dělá „Next game“; mimo feed `null`. */
export const FeedNext = createContext<(() => void) | null>(null);
/** Přechod na předchozí kartu feedu (P67 T4); mimo feed `null`. */
export const FeedPrev = createContext<(() => void) | null>(null);

/**
 * Listování feedu pro kód XR (P67 T4, `xr/XrFeed.tsx`): plátno XR je vlastní React kořen v layoutu a kontexty
 * feedu do něj nedosáhnou. `null` = feed na stránce není.
 */
export const feedSteps = shared<{ readonly next: () => void; readonly prev: () => void } | null>(null);
