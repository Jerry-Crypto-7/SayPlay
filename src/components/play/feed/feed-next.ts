import { createContext } from 'react';

/** Přechod na další kartu feedu (P54A T9) – výsledek běhu ve feedu z něj dělá „Next game“; mimo feed `null`. */
export const FeedNext = createContext<(() => void) | null>(null);
