'use client';

/**
 * Sdílení hry (P27B T5) – v HUD během hry i po ní v `PostRun`.
 *
 * Odkaz míří vždy na neměnnou verzi, kterou hráč hraje (`/play/<versionId>`),
 * ne na adresu stránky – ve feedu je to `/play?g=…`, a to se časem posune.
 * Kde prohlížeč umí `navigator.share`, otevře se jeho nabídka; jinak se odkaz
 * zkopíruje, a když ani schránka nejde (oprávnění, nezabezpečený původ),
 * ukáže se v poli k ručnímu výběru.
 *
 * Po dohrání nese i klip běhu (P29D T2): kde nabídka sdílení bere soubory,
 * jde klip s odkazem; jinak se klip stáhne a odkaz zkopíruje. Událost
 * `share` říká `withClip`, jestli klip opravdu odešel.
 *
 * Po živých změnách (P29D T10) se sdílí verze, která je nese (`live`), a rodič
 * zůstává v rodokmenu. Publikuje ji hra dopředu (R4): nabídka sdílení chce
 * čerstvé gesto (iOS Safari, Chromium po ~5 s), takže stisk na síť nečeká,
 * a dokud publikace běží, je tlačítko zablokované.
 *
 * Stisk nesmí do hry: plocha scény i klávesy hry poslouchají nativně, takže
 * ťuk i klávesu musí zastavit nativní posluchač (stejně jako tlačítko Fire).
 *
 * Vzhled (P34 T6): mimo HUD je to `Button` kitu – na výsledku „Dare a friend
 * to beat it“ (po výhře rajčatové, po prohře papírové) a odkaz „Copy link“
 * (`copy`: jen schránka, bez nabídky a klipu). Výsledek stisku řekne toast
 * kitu „Link copied. Go dare someone.“, který po 3 s zmizí.
 *
 * V HUD (P34 T7, kit `07-components.md` Screens map) kolo sdílení otevře list
 * `.sp-sheet`: rajčatové „Dare a friend“ (nabídka sdílení s odkazem, jinak
 * schránka), odkaz „Copy link“ a „Save video“ – během nahrávaného běhu
 * zašedlé s větou, že video přijde po konci (hotové ho nese výsledek). Hra pod
 * listem běží dál; klávesy z listu do ní nepropadnou, Tab a Esc patří listu.
 * Odeslaný odkaz list zavře a toast ukáže bublina nad dolní řadou.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { loopEvent, SHARE_MARK } from './loop-client';
import { COPY_LINK, DARE_SHORT, LINK_COPIED, SAVE_VIDEO, SHARE_TITLE, VIDEO_AFTER_RUN } from './starters';
import { Button, type ButtonVariant, Icon, Sheet } from './ui';

type Share = 'idle' | 'copied' | 'saved' | 'manual';

/** Toast kitu (`07-components.md`, Toast) visí 3 s. */
const TOAST_MS = 3_000;

/**
 * Klávesy z listu sdílení nesmí do běžící hry – ta poslouchá na okně nativně.
 * Tab a Esc projdou, obsluhuje je list (`holdSheet` na dokumentu).
 */
function keepKeys(element: HTMLElement | null): (() => void) | undefined {
  if (element === null) return undefined;
  const stop = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation();
  };
  element.addEventListener('keydown', stop);
  element.addEventListener('keyup', stop);
  return () => {
    element.removeEventListener('keydown', stop);
    element.removeEventListener('keyup', stop);
  };
}

/** Stažení souboru přes dočasný odkaz – prohlížeč bez sdílení souborů si klip uloží. */
function download(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Verze, která nese živé změny běhu; `partial` = část z nich (životy, čas, těla, která hra na startu nepočítá) zůstala jen v běhu. */
export interface LiveShare {
  readonly versionId: string;
  readonly partial: boolean;
}

/**
 * Publikace živých změn běhu: `pending` = běží, `ready` = hotová (`share: null`
 * = běh žádné nemá), `failed` = změny se nepodařilo uložit; sdílí se hraná
 * verze a hráč se to dozví, stejně jako o změnách, které do odkazu nejdou.
 */
export type LivePublish =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly share: LiveShare | null }
  | { readonly state: 'failed' };

export function ShareButton({
  versionId: playing,
  title,
  label = 'Share',
  variant = 'secondary',
  size = 'm',
  copy = false,
  className = '',
  clip = null,
  live,
  recording = false,
}: {
  readonly versionId: string;
  readonly title?: string;
  readonly label?: string;
  /** Varianta `Button` kitu (P34 T6); `hud` = kolo v dolní řadě HUD (P34 T5), které otevře list sdílení (P34 T7). */
  readonly variant?: ButtonVariant | 'hud';
  readonly size?: 'l' | 'm' | 's';
  /** „Copy link“: odkaz jen do schránky – bez nabídky sdílení a bez klipu. */
  readonly copy?: boolean;
  readonly className?: string;
  readonly clip?: Blob | null;
  /** Verze s živými změnami běhu (P29D T10), `undefined` = běh žádné nemá. */
  readonly live?: LivePublish;
  /** Běh se nahrává (arkáda, P29D T1): list sdílení v HUD ukáže Save video, zatím zašedlé. */
  readonly recording?: boolean;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<Share>('idle');
  const [href, setHref] = useState('');
  const [volatile, setVolatile] = useState(false);
  const [lostLive, setLostLive] = useState<'none' | 'some' | 'all'>('none');

  const toast = [
    share === 'copied' ? LINK_COPIED : share === 'saved' ? `Video saved. ${LINK_COPIED}` : '',
    volatile ? 'This server keeps games in memory only: the link stops working when it restarts.' : '',
    lostLive === 'all' ? 'Your live changes could not be saved, so the link opens the game without them.' : '',
    lostLive === 'some' ? 'Some live changes (lives, time, or what this game cannot start with) stay in your run only.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  useEffect(() => {
    if (toast === '') return;
    const timer = window.setTimeout(() => {
      setShare((now) => (now === 'manual' ? now : 'idle'));
      setVolatile(false);
      setLostLive('none');
    }, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: Event) => event.stopPropagation();
    const events = ['pointerdown', 'pointerup', 'keydown', 'keyup'] as const;
    for (const name of events) element.addEventListener(name, stop);
    return () => {
      for (const name of events) element.removeEventListener(name, stop);
    };
  }, []);

  /**
   * Server bez sdíleného úložiště (P27D T5, D1) drží hry jen v paměti procesu
   * a přizná to hlavičkou `x-play-store: memory`. Odkaz pak nesmí vypadat
   * trvale – hráč se to dozví hned u sdílení.
   */
  async function checkLasting(versionId: string): Promise<void> {
    try {
      const response = await fetch(`/api/play/games/${versionId}`, { cache: 'no-store' });
      setVolatile(response.headers.get('x-play-store') === 'memory');
    } catch {
      // Nedostupné dveře o trvalosti nic neřeknou; odkaz sám se sdílí dál.
    }
  }

  /** `onlyCopy` = „Copy link“: jen schránka, bez nabídky a klipu. Vrací `true`, když odkaz odešel. */
  async function run(onlyCopy: boolean): Promise<boolean> {
    // Žádné `await` před `navigator.share` – jinak vyprší gesto (R4).
    const shared = live?.state === 'ready' ? live.share : null;
    const versionId = shared?.versionId ?? playing;
    setLostLive(live?.state === 'failed' ? 'all' : shared?.partial === true ? 'some' : 'none');
    // `?via=share` je jediný doklad, že odkaz došel: jeho otevření je `shared_open` (P27D T4).
    const url = `${window.location.origin}/play/${versionId}?${SHARE_MARK}`;
    setHref(url);
    void checkLasting(versionId);
    // Klip běhu (P29D T2) jde s odkazem, kde nabídka sdílení soubory bere; jinak se stáhne a odkaz zkopíruje.
    const file = onlyCopy || clip === null ? null : new File([clip], `sayplay-clip.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: clip.type });
    const withFile = file !== null && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    if (!onlyCopy && typeof navigator.share === 'function' && (file === null || withFile)) {
      try {
        await navigator.share(withFile ? { title: title ?? document.title, url, files: [file] } : { title: title ?? document.title, url });
        // Sdílení patří hrané verzi – tam leží i zobrazení a výhra běhu (revize fáze 2 P29D).
        loopEvent('share', playing, { withClip: withFile });
        return true;
      } catch (error) {
        // Hráč nabídku zavřel – nic dalšího. Jiná chyba: zkusit schránku.
        if (error instanceof DOMException && error.name === 'AbortError') return false;
      }
    }
    if (file !== null) download(file);
    try {
      await navigator.clipboard.writeText(url);
      setShare(file === null ? 'copied' : 'saved');
      loopEvent('share', playing, { withClip: file !== null });
      return true;
    } catch {
      // Odkaz nedošel (jen ruční pole) – `share` se nepočítá, s klipem ani bez něj.
      setShare('manual');
      return false;
    }
  }

  /** Stisk v listu sdílení: odeslaný odkaz list zavře, toast pak ukáže bublina nad dolní řadou. */
  const send = (onlyCopy: boolean) => () => void run(onlyCopy).then((sent) => sent && setOpen(false));

  const pending = live?.state === 'pending';
  const manualField = <input className="play-share-url" readOnly value={href} aria-label="Game link" onFocus={(event) => event.target.select()} />;
  return (
    <>
      {variant === 'hud' ? (
        <>
          <button
            ref={button}
            type="button"
            className={`sp-hud-btn play-hud-round play-share ${className}`.trim()}
            data-testid="play-share"
            data-variant="hud"
            aria-label={label}
            aria-haspopup="dialog"
            disabled={pending}
            aria-busy={pending}
            onClick={() => setOpen(true)}
          >
            <Icon name="share" />
          </button>
          <Sheet open={open} title={SHARE_TITLE} className="play-share-sheet" onClose={() => setOpen(false)}>
            <div ref={keepKeys} className="play-share-options">
              <Button size="l" className="sp-btn--block" data-testid="play-share-dare" disabled={pending} aria-busy={pending} onClick={send(false)}>
                {DARE_SHORT}
              </Button>
              <div className="play-share-links">
                <Button variant="link" size="s" data-testid="play-copy-link" disabled={pending} onClick={send(true)}>
                  {COPY_LINK}
                </Button>
                {recording && (
                  <Button variant="link" size="s" disabled aria-describedby={noteId}>
                    {SAVE_VIDEO}
                  </Button>
                )}
              </div>
              {recording && (
                <p id={noteId} className="play-share-note">
                  {VIDEO_AFTER_RUN}
                </p>
              )}
              {share === 'manual' && manualField}
            </div>
          </Sheet>
        </>
      ) : (
        <Button
          ref={button}
          variant={variant}
          size={size}
          className={`play-share ${className}`.trim()}
          data-testid={copy ? 'play-copy-link' : 'play-share'}
          disabled={pending}
          aria-busy={pending}
          onClick={() => void run(copy)}
        >
          {label}
        </Button>
      )}
      {/* Oblast `aria-live` musí existovat dřív, než se do ní napíše – jinak ji čtečka nepřečte. V HUD sedí bublina nad dolní řadou, jinde toast kitu. */}
      <span className={toast === '' || variant === 'hud' ? 'play-status' : 'play-status sp-toast'} aria-live="polite">
        {toast}
      </span>
      {/* V HUD je ruční pole v listu sdílení. */}
      {share === 'manual' && variant !== 'hud' && manualField}
    </>
  );
}
