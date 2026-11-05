'use client';

/**
 * Klip karty, která nehraje (P71B T4): krátké video místo statického obrázku, ať se hýbe každá viditelná karta
 * feedu i řada „Up next“. Zdroj: klip z prohlížeče (`clip-recorder.ts`, IndexedDB) → offline klip ze sady
 * (`feed-clips.json`, `scripts/p37c/feed-thumbs.mjs --clips`) → žádný (karta ukáže obrázek).
 *
 * Dekóduje se jen video v zorném poli a jeho soused nad i pod ním: v reelu (`feed-reel`, posuvník s kartou na výšku
 * celého reelu) okraj jedné výšky reelu, mimo reel okno prohlížeče. Video mimo dosah se zastaví a pustí `src`,
 * ať telefon nedrží dekodér pro každou kartu. Při méně pohybu video nehraje a zůstane plakát.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import offline from './feed-clips.json';

const REDUCE = '(prefers-reduced-motion: reduce)';
const OFFLINE = new Set<string>(offline);
/** Soused nad a pod kartou: v reelu má každá karta výšku reelu. */
const NEIGHBOUR_MARGIN = '100% 0px';

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(REDUCE);
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    },
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}

/** Offline klip hry ze sady; hra mimo `feed-clips.json` žádný nemá (jinak by video dostalo 404). */
export function offlineClip(versionId: string): string | undefined {
  return OFFLINE.has(versionId) ? `/play/feed-clips/${versionId}.mp4` : undefined;
}

export type ClipVideo = Pick<HTMLVideoElement, 'pause' | 'play' | 'load' | 'getAttribute' | 'hasAttribute' | 'removeAttribute'> & { src: string };

function release(video: ClipVideo): void {
  video.pause();
  if (!video.hasAttribute('src')) return;
  video.removeAttribute('src');
  // Bez `load()` drží prohlížeč dekodér i po odebrání `src`.
  video.load();
}

/** Video v dosahu (zorné pole ±1 soused) dostane `src` a hraje; mimo dosah se zastaví a dekodér pustí. */
export function clipInSight(video: ClipVideo, src: string, inSight: boolean): void {
  if (!inSight) {
    release(video);
    return;
  }
  if (video.getAttribute('src') !== src) video.src = src;
  // Prohlížeč autoplay odmítl (úspora dat): zůstane plakát.
  video.play().catch(() => undefined);
}

export function CardClip({ src, poster, className }: { readonly src: string; readonly poster: string; readonly className: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = video.current;
    if (element === null || reduced) return;
    const observer = new IntersectionObserver(([entry]) => clipInSight(element, src, entry?.isIntersecting === true), {
      root: element.closest('[data-testid="feed-reel"]'),
      rootMargin: NEIGHBOUR_MARGIN,
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      release(element);
    };
  }, [src, reduced]);
  return <video ref={video} className={className} data-testid="card-clip" muted playsInline loop preload="none" poster={poster} aria-hidden="true" />;
}
