/** Typy k `play-extend-ttl.mjs` – skript jede holým Nodem, testy jsou TypeScript. */

export declare function extendPlayTtl(
  config: { url: string; token: string; prefix: string; ttlSeconds: number; apply: boolean; now: number },
  fetchImpl?: typeof fetch,
): Promise<{ games: number; extended: number; expired: number; unreadable: number }>;
