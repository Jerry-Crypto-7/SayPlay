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
 */

import { useEffect, useRef, useState } from 'react';

import { loopEvent, SHARE_MARK } from './loop-client';
import { Icon } from './ui';

type Share = 'idle' | 'copied' | 'saved' | 'manual';

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
  variant = 'accent',
  className = '',
  clip = null,
  live,
}: {
  readonly versionId: string;
  readonly title?: string;
  readonly label?: string;
  /** Váha tlačítka (P33 T4): v kartě po hře je sdílení vedlejší cesta; `rail` = kolo v bočním sloupci hry (T12). */
  readonly variant?: 'accent' | 'quiet' | 'rail';
  readonly className?: string;
  readonly clip?: Blob | null;
  /** Verze s živými změnami běhu (P29D T10), `undefined` = běh žádné nemá. */
  readonly live?: LivePublish;
}) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [share, setShare] = useState<Share>('idle');
  const [href, setHref] = useState('');
  const [volatile, setVolatile] = useState(false);
  const [lostLive, setLostLive] = useState<'none' | 'some' | 'all'>('none');

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

  async function run(): Promise<void> {
    // Žádné `await` před `navigator.share` – jinak vyprší gesto (R4).
    const shared = live?.state === 'ready' ? live.share : null;
    const versionId = shared?.versionId ?? playing;
    setLostLive(live?.state === 'failed' ? 'all' : shared?.partial === true ? 'some' : 'none');
    // `?via=share` je jediný doklad, že odkaz došel: jeho otevření je `shared_open` (P27D T4).
    const url = `${window.location.origin}/play/${versionId}?${SHARE_MARK}`;
    setHref(url);
    void checkLasting(versionId);
    // Klip běhu (P29D T2) jde s odkazem, kde nabídka sdílení soubory bere; jinak se stáhne a odkaz zkopíruje.
    const file = clip === null ? null : new File([clip], `worldstream-clip.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: clip.type });
    const withFile = file !== null && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    if (typeof navigator.share === 'function' && (file === null || withFile)) {
      try {
        await navigator.share(withFile ? { title: title ?? document.title, url, files: [file] } : { title: title ?? document.title, url });
        // Sdílení patří hrané verzi – tam leží i zobrazení a výhra běhu (revize fáze 2 P29D).
        loopEvent('share', playing, { withClip: withFile });
        return;
      } catch (error) {
        // Hráč nabídku zavřel – nic dalšího. Jiná chyba: zkusit schránku.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    if (file !== null) download(file);
    try {
      await navigator.clipboard.writeText(url);
      setShare(file === null ? 'copied' : 'saved');
      loopEvent('share', playing, { withClip: file !== null });
    } catch {
      // Odkaz nedošel (jen ruční pole) – `share` se nepočítá, s klipem ani bez něj.
      setShare('manual');
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${variant === 'rail' ? 'play-icon-button' : `play-button play-button-${variant}`} play-share ${className}`.trim()}
        data-testid="play-share"
        data-variant={variant}
        disabled={live?.state === 'pending'}
        aria-busy={live?.state === 'pending'}
        onClick={() => void run()}
      >
        {variant === 'rail' ? (
          <>
            <span className="play-icon-button-disc">
              <Icon name="share" />
            </span>
            <span className="play-icon-button-caption">{label}</span>
          </>
        ) : (
          <>
            <Icon name="share" />
            {label}
          </>
        )}
      </button>
      {/* Oblast `aria-live` musí existovat dřív, než se do ní napíše – jinak ji čtečka nepřečte. */}
      <span className="play-status" aria-live="polite">
        {share === 'copied' ? 'Link copied' : share === 'saved' ? 'Clip saved, link copied' : ''}
        {volatile ? `${share === 'copied' || share === 'saved' ? '. ' : ''}This server keeps games in memory only: the link stops working when it restarts.` : ''}
        {lostLive === 'all' ? ' Your live changes could not be saved, so the link opens the game without them.' : ''}
        {lostLive === 'some' ? ' Some live changes (lives, time, or what this game cannot start with) stay in your run only.' : ''}
      </span>
      {share === 'manual' && <input className="play-share-url" readOnly value={href} aria-label="Game link" onFocus={(event) => event.target.select()} />}
    </>
  );
}
