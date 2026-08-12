import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  readonly requestId: string;
}

/**
 * Korelační ID požadavku.
 *
 * `AsyncLocalStorage`, ne modulová proměnná: emisní cesta obsluhuje víc
 * požadavků současně a modulová proměnná by při prvním `await` přepsala kontext
 * sousedovi. T17 na tomhle staví řetězení stadií — dvě prokládané emise se
 * sdíleným ID by daly log, který vypadá platně a popisuje běh, který se nestal.
 *
 * Tohle je jen instalatérství. End-to-end důkaz, že ID projde celým řetězcem, je
 * AC úlohy T17.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Spustí `fn` pod daným korelačním ID. ID se propaguje přes `await` i přes
 * callbacky bez explicitního parametru a přežije vyhozenou výjimku — `run`
 * obnovuje předchozí kontext i při odvinutí zásobníku.
 */
export function withRequest<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** `undefined` mimo požadavek. Kód, který běží i jinde, si tak nevynutí falešné ID. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
