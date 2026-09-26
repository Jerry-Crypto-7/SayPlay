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
 * Stisk nesmí do hry: plocha scény i klávesy hry poslouchají nativně, takže
 * ťuk i klávesu musí zastavit nativní posluchač (stejně jako tlačítko Fire).
 */

import { useEffect, useRef, useState } from 'react';

import { loopEvent, SHARE_MARK } from './loop-client';

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

export function ShareButton({ versionId, title, label = 'Share', className = '', clip = null }: { readonly versionId: string; readonly title?: string; readonly label?: string; readonly className?: string; readonly clip?: Blob | null }) {
  const button = useRef<HTMLButtonElement | null>(null);
  const [share, setShare] = useState<Share>('idle');
  const [href, setHref] = useState('');
  const [volatile, setVolatile] = useState(false);

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
  async function checkLasting(): Promise<void> {
    try {
      const response = await fetch(`/api/play/games/${versionId}`, { cache: 'no-store' });
      setVolatile(response.headers.get('x-play-store') === 'memory');
    } catch {
      // Nedostupné dveře o trvalosti nic neřeknou; odkaz sám se sdílí dál.
    }
  }

  async function run(): Promise<void> {
    // `?via=share` je jediný doklad, že odkaz došel: jeho otevření je `shared_open` (P27D T4).
    const url = `${window.location.origin}/play/${versionId}?${SHARE_MARK}`;
    setHref(url);
    void checkLasting();
    // Klip běhu (P29D T2) jde s odkazem, kde nabídka sdílení soubory bere; jinak se stáhne a odkaz zkopíruje.
    const file = clip === null ? null : new File([clip], `worldstream-clip.${clip.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: clip.type });
    const withFile = file !== null && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    if (typeof navigator.share === 'function' && (file === null || withFile)) {
      try {
        await navigator.share(withFile ? { title: title ?? document.title, url, files: [file] } : { title: title ?? document.title, url });
        loopEvent('share', versionId, { withClip: withFile });
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
      loopEvent('share', versionId, { withClip: file !== null });
    } catch {
      setShare('manual');
      if (file !== null) loopEvent('share', versionId, { withClip: true });
    }
  }

  return (
    <>
      <button ref={button} type="button" className={`play-button play-share ${className}`.trim()} data-testid="play-share" onClick={() => void run()}>
        {label}
      </button>
      {/* Oblast `aria-live` musí existovat dřív, než se do ní napíše – jinak ji čtečka nepřečte. */}
      <span className="play-status" aria-live="polite">
        {share === 'copied' ? 'Link copied' : share === 'saved' ? 'Clip saved, link copied' : ''}
        {volatile ? `${share === 'copied' || share === 'saved' ? '. ' : ''}This server keeps games in memory only: the link stops working when it restarts.` : ''}
      </span>
      {share === 'manual' && <input className="play-share-url" readOnly value={href} aria-label="Game link" onFocus={(event) => event.target.select()} />}
    </>
  );
}
