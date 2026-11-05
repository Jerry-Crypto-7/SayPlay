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

/** Video v dosahu (zorné pole ±1 soused) dostane `src` a hraje (`plays`) nebo stojí; mimo dosah se zastaví a dekodér pustí. */
export function clipInSight(video: ClipVideo, src: string, inSight: boolean, plays = true): void {
  if (!inSight) {
    release(video);
    return;
  }
  if (video.getAttribute('src') !== src) video.src = src;
  if (!plays) {
    video.pause();
    return;
  }
  // Prohlížeč autoplay odmítl (úspora dat): zůstane plakát. Na dohraném videu `play()` začne od začátku.
  video.play().catch(() => undefined);
}

export type ClipMember = { readonly onTurn: () => void };
export type ClipTurns = ReturnType<typeof createClipTurns>;

/**
 * Tah mezi klipy v zorném poli: hraje vždy jen jeden, po jedné smyčce předá tah dalšímu viditelnému.
 * Dvě a víc naráz viditelných hrajících videí vedle živého plátna srazí aktivní kartu na 30 FPS (P71B T5,
 * `evals/play/p71/feed/README.md`); jedno viditelné video nebo soused mimo obraz nic nestojí.
 * simplified: jeden viditelný klip naráz, zvednout po měření na skutečném desktopu s překryvnými vrstvami.
 */
export function createClipTurns() {
  const visible: ClipMember[] = [];
  let turn: ClipMember | undefined;
  const give = (next: ClipMember | undefined) => {
    turn = next;
    next?.onTurn();
  };
  return {
    has: (member: ClipMember) => turn === member,
    seen(member: ClipMember, inView: boolean) {
      const at = visible.indexOf(member);
      if (inView) {
        if (at === -1) visible.push(member);
        if (turn === undefined) give(member);
        return;
      }
      if (at === -1) return;
      visible.splice(at, 1);
      if (turn === member) give(visible.length === 0 ? undefined : visible[at % visible.length]);
    },
    /** Klip na tahu dohrál: tah dostane další viditelný (sám jediný hraje znovu). */
    ended(member: ClipMember) {
      if (turn !== member) return;
      give(visible[(visible.indexOf(member) + 1) % visible.length]);
      // Tah přešel: dohraný klip zůstane stát.
      if (turn !== member) member.onTurn();
    },
  };
}

/** Celá stránka (reel i „Up next“) sdílí jeden tah. */
const PAGE_TURNS = createClipTurns();

/**
 * Klip jednoho videa: mimo dosah pustí dekodér; v dosahu, ale mimo obraz (soused v reelu) hraje dokola;
 * v obraze hraje jen na tahu. Video nemá `loop` – smyčku dělá `ended`, ať tah může přejít.
 */
export function joinClipTurns(video: ClipVideo, src: string, turns: ClipTurns) {
  let inReach = false;
  let inView = false;
  const member: ClipMember = { onTurn: () => clipInSight(video, src, inReach, !inView || turns.has(member)) };
  return {
    reach(value: boolean) {
      inReach = value;
      member.onTurn();
    },
    view(value: boolean) {
      inView = value;
      turns.seen(member, value);
      member.onTurn();
    },
    /** Konec smyčky nebo vadný klip: v obraze předá tah, mimo obraz hraje znovu. */
    ended() {
      if (inView) turns.ended(member);
      else member.onTurn();
    },
    leave() {
      inReach = false;
      turns.seen(member, false);
      release(video);
    },
  };
}

export function CardClip({ src, poster, className }: { readonly src: string; readonly poster: string; readonly className: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const element = video.current;
    if (element === null || reduced) return;
    const clip = joinClipTurns(element, src, PAGE_TURNS);
    const reach = new IntersectionObserver(([entry]) => clip.reach(entry?.isIntersecting === true), {
      root: element.closest('[data-testid="feed-reel"]'),
      rootMargin: NEIGHBOUR_MARGIN,
    });
    // Bez kořene a okraje = opravdu vidět v okně (posuvník reelu ořízne kartu mimo obraz).
    const view = new IntersectionObserver(([entry]) => clip.view(entry?.isIntersecting === true));
    reach.observe(element);
    view.observe(element);
    const ended = () => clip.ended();
    element.addEventListener('ended', ended);
    element.addEventListener('error', ended);
    return () => {
      reach.disconnect();
      view.disconnect();
      element.removeEventListener('ended', ended);
      element.removeEventListener('error', ended);
      clip.leave();
    };
  }, [src, reduced]);
  return <video ref={video} className={className} data-testid="card-clip" muted playsInline preload="none" poster={poster} aria-hidden="true" />;
}
