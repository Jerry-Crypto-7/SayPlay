'use client';

/**
 * Sdílení z VR (P67 T5): „Share“ na panelu výsledku otevře místo výsledku kartu s QR kódem odkazu a větou
 * „Scan with your phone“ – v brýlích není schránka ani pole s odkazem, telefon v ruce kód přečte. Kód kreslí
 * `XrPanel` do plátna karty (`qr.ts`, knihovna jen v XR chunku).
 *
 * - **Výhra:** odkaz nese výzvu (`&dare=<id>`) jako ve 2D. Vstupy a živé změny běhu jdou přes `publishDare`
 *   (import z `ShareButton`, beze změny): server běh přehraje a uloží, režisér se nevolá – útrata 0. Výsledek 2D
 *   (`ArcadePlay`) poslal tytéž vstupy hned po výhře a id výzvy je hash obsahu, takže druhé poslání vrátí totéž id.
 *   Volající má ale strop 1 výzva za 10 s (`rate-limit.ts`): odmítnuté poslání se zkusí znovu po 3 s, nejvýš
 *   čtyřikrát (okno stropu to přečká); mezitím karta říká „Getting your link…“. Když výzva nevyjde, jde obyčejný
 *   odkaz a věta jako ve 2D.
 * - **Prohra:** obyčejný odkaz na hru – prohraný běh server jako výzvu odmítne a volajícímu by to vzalo okno.
 * - „Share link“ jen tam, kde prohlížeč má `navigator.share`; „Done“ (jediná rajčatová akce) vrátí výsledek.
 * - Ve feedu karta drží výsledek, dokud je otevřená (`KEEP_RESULT_MS`).
 *
 * Hraná verze je z adresy: stránka hry `/play/<id>`, feed `/play?g=<id>` (feed adresu drží s aktivní kartou).
 * `XrHudView` výzvu z `ArcadePlay` nenese – přidat ji chce řádek v `ArcadePlay.tsx` mimo výjimky plánu
 * (`docs/vr/README.md`).
 */

import { useEffect, useState } from 'react';

import { loopEvent, SHARE_MARK } from '../loop-client';
import { publishDare } from '../ShareButton';
import type { XrHudView } from './xr-context';
import { DONE } from './XrComfort';
import type { PanelSpec } from './XrPanel';

export const SHARE = 'Share';
export const SCAN = 'Scan with your phone';
export const SHARE_LINK = 'Share link';
export const GETTING_LINK = 'Getting your link…';
/** Věta 2D (`ShareButton`), když výzva nevyjde. */
export const NO_SCORE = "Couldn't attach your score, so the link opens just the game.";

/** Další pokusy o výzvu po odmítnutí a rozestup mezi nimi: 4 × 3 s přečkají okno stropu volajícího (10 s). */
const RETRIES = 4;
const RETRY_MS = 3_000;

/**
 * Feed vrátí výsledek po 10 s bez stisku na stránce do náhledu robota (`ReelCard`, `useResultIdle`) a ovladače se
 * za stisk nepočítají. Dokud je karta otevřená, ohlásí se proto po 2 s stisk na samotném okně: bez prvku jako cíle
 * ho hra ani feed nepřevezmou, jen hodiny nečinnosti začnou znovu – kód nezmizí hráči, který ho ukazuje telefonu.
 */
const KEEP_RESULT_MS = 2_000;

/** Id verze jako ve dveřích API (`VERSION_ID_PATTERN`). */
const VERSION_ID = /^[a-f0-9]{8,64}$/;

/** Hraná verze z adresy: stránka hry `/play/<id>`, feed `/play?g=<id>`; jinde `null` (sdílet není co). */
export function playingVersion(at: { readonly pathname: string; readonly search: string }): string | null {
  const page = /^\/play\/([^/]+)\/?$/.exec(at.pathname)?.[1] ?? null;
  const id = page ?? (at.pathname === '/play' ? new URLSearchParams(at.search).get('g') : null);
  return id !== null && VERSION_ID.test(id) ? id : null;
}

type Ready = { readonly state: 'ready'; readonly versionId: string; readonly url: string; readonly dare: boolean; readonly noScore: boolean };
/** Odkaz karty: `pending` = výzva se ukládá, `ready` = hotový (`noScore` = výzva nevyšla, jde jen hra). */
export type ShareLink = { readonly state: 'pending' } | Ready;

/** Odkaz pro kartu sdílení, dokud je otevřená (`open`) nad výsledkem `view`; `null` = zavřená nebo verze v adrese není. */
export function useShareLink(view: XrHudView | null, open: boolean): ShareLink | null {
  const [link, setLink] = useState<ShareLink | null>(null);
  const session = view?.session ?? null;
  const result = view?.result ?? null;
  useEffect(() => {
    const versionId = playingVersion(window.location);
    if (!open || session === null || result === null || versionId === null) {
      setLink(null);
      return undefined;
    }
    const base = `${window.location.origin}/play/${versionId}?${SHARE_MARK}`;
    const plain = (noScore: boolean): Ready => ({ state: 'ready', versionId, url: base, dare: false, noScore });
    if (result === 'lost') {
      setLink(plain(false));
      return undefined;
    }
    let live = true;
    let timer: number | undefined;
    const inputs = session.inputs();
    const patches = session.patches();
    const attempt = (left: number): void => {
      publishDare(versionId, inputs, patches).then(
        (dareId) => {
          if (live) setLink({ state: 'ready', versionId, url: `${base}&dare=${dareId}`, dare: true, noScore: false });
        },
        () => {
          if (!live) return;
          if (left === 0) setLink(plain(true));
          else timer = window.setTimeout(() => attempt(left - 1), RETRY_MS);
        },
      );
    };
    setLink({ state: 'pending' });
    attempt(RETRIES);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, session, result]);
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setInterval(() => window.dispatchEvent(new PointerEvent('pointerdown')), KEEP_RESULT_MS);
    return () => window.clearInterval(timer);
  }, [open]);
  return link;
}

/** Odkaz do nabídky sdílení prohlížeče; `share` se počítá, jen když odkaz odešel (jako ve 2D). */
async function sendLink(link: Ready): Promise<void> {
  try {
    await navigator.share({ title: document.title, url: link.url });
    loopEvent('share', link.versionId, { withClip: false, dare: link.dare });
  } catch {
    // Nabídka zavřená, nebo ji prohlížeč v relaci nepustil: kód na kartě zůstává.
  }
}

/** Karta sdílení místo výsledku: titulek, QR kód (až je odkaz hotový), věta, „Share link“ a „Done“. */
export function sharePanelOf(link: ShareLink, width: number, done: () => void): PanelSpec {
  const ready = link.state === 'ready' ? link : null;
  return {
    id: 'share',
    width,
    title: SHARE,
    ...(ready === null ? { body: GETTING_LINK } : { qr: ready.url, body: SCAN }),
    ...(ready?.noScore === true ? { note: NO_SCORE } : {}),
    buttons: [
      ...(ready !== null && typeof navigator.share === 'function' ? [{ id: 'link', label: SHARE_LINK, press: () => void sendLink(ready) }] : []),
      { id: 'done', label: DONE, primary: true, press: done },
    ],
  };
}
