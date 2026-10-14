/**
 * Banner průběhu (P45C T16, úseky P46B T7): štítek kitu `sp-world-tag` nad hrou, když na plochu přijde první
 * nové chování („Here they come!“), když úsek 2 či 3 něco změní („Faster!“, „New foe: Fox“, „Narrow road!“) a když
 * začne finále („Boss: Fox“, „Final wave!“ …). Co a kdy ohlásit, říká čistá `pacingBeatOf` a změnu úseku
 * `segmentNewsOf` (`pieces/pacing.ts`) ze světa a stavu – banner nic nepočítá, jen drží, co už ukázal: každou
 * chvíli jednou za běh, v pořadí úsek 2, úsek 3, finále (stupňování před finále), nikdy naopak, na 1,4 s herního
 * času (pauza ho podrží). Restart (tik zpět) začne znovu. Hra bez finále banner nemá. Jméno nepřítele a bosse je
 * popisek role z věty, jejíž model je kreslí (`chaserName`). `prefers-reduced-motion` vypne náběh, text zůstane (`play.css`).
 */

import { useState, useSyncExternalStore } from 'react';

import { ARCADE_HZ, HEADER } from '@/play/arcade/contract';
import { type BeatWorld, type FINALES, type PacingBeat, type SegmentNews, pacingBeatOf, segmentNewsOf } from '@/play/arcade/pieces/pacing';

import type { ArcadeSession } from './session';

/** Co banner řekne (anglicky, sentence case, `docs/brand/docs/11-voice-copy.md`) – jen to, co hra opravdu má. */
export const PACING_BANNER_LABELS: Readonly<Record<'buildUp' | (typeof FINALES)[number], string>> = {
  buildUp: 'Here they come!',
  boss: 'Boss!',
  wave: 'Final wave!',
  sprint: 'Final sprint!',
  // Stanoviště: poslední kolo s dvojím úkolem; souboj dvou: poslední soupeř se rozzuří.
  round: 'Last round!',
  // Hod: bonusový terč posledního kola.
  bonus: 'Last round!',
  // Načasování: v posledních třech kolech minutí prohrává i se životy – „Last round!“ by lhalo o dvě kola.
  sudden: 'Sudden death!',
  // Rytmus: rychlá závěrečná fráze.
  phrase: 'Big finish!',
  escape: 'Hold on!',
};

/** Změna úseku bez jména; nový nepřítel s jménem z věty je „New foe: Fox“ (`pacingBannerLabel`). */
export const SEGMENT_NEWS_LABELS: Readonly<Record<SegmentNews, string>> = {
  newFoe: 'New foe!',
  narrow: 'Narrow road!',
  trap: 'New trap!',
  moving: 'Platforms move!',
  faster: 'Faster!',
};

/** Jak dlouho banner visí: 1,4 s herního času. */
export const PACING_BANNER_TICKS = Math.round(1.4 * ARCADE_HZ);

/** Pořadí chvil za běh: chvíle nižší než už ohlášená se neohlásí (stupňování a úsek 2 < úsek 3 < finále). */
const rankOf = (beat: PacingBeat): number => (beat === 'buildUp' || beat === 'segment2' ? 1 : beat === 'segment3' ? 2 : 3);

/** Změna úseku, kterou banner u chvíle úseku ohlásí; jiná chvíle žádnou. */
export const newsOf = (world: BeatWorld, beat: PacingBeat): SegmentNews | undefined => segmentNewsOf(world).find((item) => item.beat === beat)?.news;

/** Jméno z věty jako začátek nápisu: „police helicopter“ → „Police helicopter“. */
const named = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** Nápis chvíle: nový nepřítel a boss se jménem z věty (`foe`), bez něj pevný nápis. */
export function pacingBannerLabel(world: BeatWorld, beat: PacingBeat, foe?: string): string {
  if (beat === 'segment2' || beat === 'segment3') {
    const news = newsOf(world, beat) as SegmentNews;
    return news === 'newFoe' && foe !== undefined ? `New foe: ${named(foe)}` : SEGMENT_NEWS_LABELS[news];
  }
  return beat === 'boss' && foe !== undefined ? `Boss: ${named(foe)}` : PACING_BANNER_LABELS[beat];
}

export interface PacingBannerWatch {
  /** Stav po tiku → chvíle, kterou banner právě ukazuje, nebo `null`. Týž tik dvakrát dá totéž. */
  see(state: Int32Array): PacingBeat | null;
}

export function createPacingBannerWatch(world: BeatWorld): PacingBannerWatch {
  let seen = -1;
  let rank = 0;
  let shown: { readonly beat: PacingBeat; readonly from: number } | null = null;
  return {
    see(state) {
      const tick = state[HEADER.tick] as number;
      if (tick < seen) {
        rank = 0;
        shown = null;
      }
      seen = tick;
      const beat = pacingBeatOf(world, state);
      if (beat !== null && rankOf(beat) > rank) {
        rank = rankOf(beat);
        shown = { beat, from: tick };
      }
      return shown !== null && tick - shown.from < PACING_BANNER_TICKS ? shown.beat : null;
    },
  };
}

export function PacingBanner({ session, enabled, foe }: { readonly session: Pick<ArcadeSession, 'world' | 'state' | 'subscribe'>; readonly enabled: boolean; readonly foe?: string | undefined }) {
  const [watch] = useState(() => createPacingBannerWatch(session.world));
  const read = (): PacingBeat | null => watch.see(session.state());
  const beat = useSyncExternalStore(session.subscribe, read, read);
  if (!enabled || beat === null) return null;
  return (
    <p key={beat} className="sp-world-tag play-pacing-banner" data-testid="play-pacing-banner" data-beat={beat} data-news={newsOf(session.world, beat)} role="status">
      {pacingBannerLabel(session.world, beat, foe)}
    </p>
  );
}
