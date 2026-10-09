/**
 * Banner průběhu (P45C T16): štítek kitu `sp-world-tag` nad hrou, když na plochu přijde první nové chování
 * („Here they come!“) a když začne finále („Boss!“, „Final wave!“ …). Co ohlásit, říká čistá `pacingBeatOf`
 * (`pieces/pacing.ts`) ze stavu – banner nic nepočítá, jen drží, co už ukázal: každou chvíli jednou za běh,
 * finále po stupňování, nikdy naopak, na 1,4 s herního času (pauza ho podrží). Restart (tik zpět) začne
 * znovu. Hra bez finále banner nemá. `prefers-reduced-motion` vypne náběh, text zůstane (`play.css`).
 */

import { useState, useSyncExternalStore } from 'react';

import { ARCADE_HZ, type ArcadeWorld, HEADER } from '@/play/arcade/contract';
import { type PacingBeat, pacingBeatOf } from '@/play/arcade/pieces/pacing';

import type { ArcadeSession } from './session';

/** Co banner řekne (anglicky, sentence case, `docs/brand/docs/11-voice-copy.md`) – jen to, co hra opravdu má. */
export const PACING_BANNER_LABELS: Readonly<Record<PacingBeat, string>> = {
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

/** Jak dlouho banner visí: 1,4 s herního času. */
export const PACING_BANNER_TICKS = Math.round(1.4 * ARCADE_HZ);

/** Stupňování před finále: chvíle nižší než už ohlášená se neohlásí. */
const rankOf = (beat: PacingBeat): number => (beat === 'buildUp' ? 1 : 2);

export interface PacingBannerWatch {
  /** Stav po tiku → chvíle, kterou banner právě ukazuje, nebo `null`. Týž tik dvakrát dá totéž. */
  see(state: Int32Array): PacingBeat | null;
}

export function createPacingBannerWatch(world: Pick<ArcadeWorld, 'rules' | 'control'>): PacingBannerWatch {
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

export function PacingBanner({ session, enabled }: { readonly session: Pick<ArcadeSession, 'world' | 'state' | 'subscribe'>; readonly enabled: boolean }) {
  const [watch] = useState(() => createPacingBannerWatch(session.world));
  const read = (): PacingBeat | null => watch.see(session.state());
  const beat = useSyncExternalStore(session.subscribe, read, read);
  if (!enabled || beat === null) return null;
  return (
    <p key={beat} className="sp-world-tag play-pacing-banner" data-testid="play-pacing-banner" data-beat={beat} role="status">
      {PACING_BANNER_LABELS[beat]}
    </p>
  );
}
