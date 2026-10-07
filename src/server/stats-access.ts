import { createHash, timingSafeEqual } from 'node:crypto';

import { sharedStoreFromEnv } from './spend-store';

/** Kratší `PLAY_STATS_KEY` je chyba nastavení: stránka zůstane zavřená. */
export const STATS_KEY_MIN_CHARS = 24;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Brána interní `/play/stats` (P44B T13). S `PLAY_STATS_KEY` pustí jen jediný `?key=` shodný
 * s klíčem, porovnaný v konstantním čase nad hashi (délka klíče z doby odpovědi nevyteče). Bez
 * klíče pustí jen lokální běh: `VERCEL` i sdílené úložiště znamenají veřejné nasazení – přepínač
 * „Automatically expose System Environment Variables“ `VERCEL` zhasne, sdílené úložiště zůstane
 * (stejné pravidlo jako `identitySecret`). `VERCEL_ENV` nic neznačí: lokálně si ho dává, kdo chce
 * platit (`.env.example`), a sada testů jím dokládá jeden proces. `false` = 404.
 */
export function statsAccess(searchParams: { readonly key?: string | string[] }, env: Record<string, string | undefined>): boolean {
  const key = env.PLAY_STATS_KEY ?? '';
  if (key === '') return env.VERCEL === undefined && sharedStoreFromEnv(env) === null;
  const supplied = searchParams.key;
  if (key.length < STATS_KEY_MIN_CHARS || typeof supplied !== 'string') return false;
  return timingSafeEqual(digest(supplied), digest(key));
}
