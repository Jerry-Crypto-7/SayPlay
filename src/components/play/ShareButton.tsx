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
 * Stisk nesmí do hry: plocha scény i klávesy hry poslouchají nativně, takže
 * ťuk i klávesu musí zastavit nativní posluchač (stejně jako tlačítko Fire).
 */

import { useEffect, useRef, useState } from 'react';

type Share = 'idle' | 'copied' | 'manual';

export function ShareButton({ versionId, title, label = 'Share', className = '' }: { readonly versionId: string; readonly title?: string; readonly label?: string; readonly className?: string }) {
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
    const url = `${window.location.origin}/play/${versionId}`;
    setHref(url);
    void checkLasting();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: title ?? document.title, url });
        return;
      } catch (error) {
        // Hráč nabídku zavřel – nic dalšího. Jiná chyba: zkusit schránku.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShare('copied');
    } catch {
      setShare('manual');
    }
  }

  return (
    <>
      <button ref={button} type="button" className={`play-button play-share ${className}`.trim()} data-testid="play-share" onClick={() => void run()}>
        {label}
      </button>
      {/* Oblast `aria-live` musí existovat dřív, než se do ní napíše – jinak ji čtečka nepřečte. */}
      <span className="play-status" aria-live="polite">
        {share === 'copied' ? 'Link copied' : ''}
        {volatile ? `${share === 'copied' ? '. ' : ''}This server keeps games in memory only: the link stops working when it restarts.` : ''}
      </span>
      {share === 'manual' && <input className="play-share-url" readOnly value={href} aria-label="Game link" onFocus={(event) => event.target.select()} />}
    </>
  );
}
