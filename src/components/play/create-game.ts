/**
 * Věta → hra (P67 T2): `POST /api/play/games` a adresa nové hry, nebo věta kitu, proč hra nevznikla. Jedna funkce
 * pro formulář na `/play` (`CreateGame.tsx`) i pro VR lobby (`xr/XrLobby.tsx`); navigaci dělá volající.
 */

import { BUILD_FAILED, NOT_SENT } from './starters';

/**
 * `offline` = prohlížeč hlásí, že je bez sítě. Formulář pak větu podrží a pošle sám, až se síť vrátí (kit, Offline);
 * `error` je i tehdy věta pro plochu, která sama znovu neposílá.
 */
export type Created = { readonly url: string } | { readonly error: string; readonly offline: boolean };

/**
 * Co hráč uslyší, když dveře hru nepostaví. 422 (věta nešla na hratelnou hru)
 * je „Build failed“ z kitu – technický důvod serveru hráči nic neřekne; ostatní
 * (kvóta, vypnutí, úložiště) nesou vlastní větu, jen s velkým písmenem na začátku.
 */
function doorMessage(status: number, code: unknown, message: unknown): string {
  if (typeof message !== 'string' || message === '') return BUILD_FAILED;
  // Zakázané téma ve větě (P40 T1) i v návrhu z ní (T2): dveře posílají větu kitu „Blocked content“ – „Try fewer rules“ by hráče poslal zkoušet totéž znovu.
  if (code === 'SENTENCE_REJECTED' || code === 'CONTENT_REJECTED') return message;
  if (status === 422) return BUILD_FAILED;
  return message[0]!.toUpperCase() + message.slice(1);
}

/**
 * Odchod z `/play` na novou hru (P78 T1). Feed na téže stránce píše `?g=` přes `history` a Next takový zápis bere jako
 * navigaci, která rozběhnutý `router.push` na hru zahodí: hráč pak visí na „Building the world“ navždy (sonda produkce
 * 8. 11.: 1 ze 4 odeslání hned po načtení, feed dosedl během přechodu). Od `openGame` feed adresu nepřepisuje.
 */
let leaving = false;

export function openGame(router: { push(href: string): void }, url: string): void {
  leaving = true;
  router.push(url);
}

/** Feed je (znovu) na obrazovce – po Back z hry smí `?g=` zase psát. */
export function stayOnFeed(): void {
  leaving = false;
}

/** Zápis `?g=` feedu: skok přidá záznam historie, dosednutí jen přepíše. Během odchodu na novou hru nic. */
export function writeFeedAddress(mode: 'push' | 'replace', versionId: string): void {
  if (leaving) return;
  if (mode === 'push') window.history.pushState(null, '', `?g=${versionId}`);
  else window.history.replaceState(null, '', `?g=${versionId}`);
}

export async function createGame(sentence: string): Promise<Created> {
  let response: Response;
  try {
    response = await fetch('/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sentence }),
    });
  } catch {
    return { error: NOT_SENT, offline: !navigator.onLine };
  }
  // Tělo, které není JSON (výpadek za proxy), je selhání stavby jako každé jiné.
  const body = (await response.json().catch(() => ({}))) as { url?: unknown; error?: { code?: unknown; message?: unknown } };
  if (!response.ok || typeof body.url !== 'string') return { error: doorMessage(response.status, body.error?.code, body.error?.message), offline: false };
  return { url: body.url };
}
