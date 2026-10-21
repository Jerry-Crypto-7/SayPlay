/**
 * Ohlášení událostí pruhových žánrů (P55 T5): když se v obraze poprvé ukáže bonus nové události, štítek kitu
 * `sp-world-tag` pod bannerem průběhu řekne, co přišlo – „Bonus run!“, „Gold!“, „Rush!“ – na 1,4 s herního času.
 * Událost se pozná podle značky v HP těla (`EVENT_MARK`); co je „v obraze“, ví žánr (`visible`). Banner nic
 * nepočítá do stavu: čte stav po tiku a drží, co už ukázal. Restart (tik zpět) začne znovu.
 */

import { useState, useSyncExternalStore } from 'react';

import { type ArcadeWorld, BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp, nativeRule } from '@/play/arcade/contract';
import { catchInView } from '@/play/arcade/pieces/catch-fall';
import { defenseInView } from '@/play/arcade/pieces/lane-defense';
import { type LaneEventKind, eventOfMark } from '@/play/arcade/pieces/lane-events';
import { sliceInView } from '@/play/arcade/pieces/slice';
import { whackInView } from '@/play/arcade/pieces/whack';

import { PACING_BANNER_TICKS } from './PacingBanner';
import type { ArcadeSession } from './session';

/** World tagy kitu (≤ 12 znaků, `docs/brand/docs/11-voice-copy.md`). */
export const LANE_EVENT_LABELS: Readonly<Record<LaneEventKind, string>> = {
  series: 'Bonus run!',
  golden: 'Gold!',
  rush: 'Rush!',
};

export interface LaneEventWatch {
  /** Stav po tiku → událost, kterou štítek právě ukazuje, nebo `null`. */
  see(state: Int32Array): LaneEventKind | null;
}

/**
 * Nová událost = bonus jiného druhu než ten předchozí, nebo po mezeře bez bonusu v obraze.
 * Série tří bonusů je jedno ohlášení, ne tři.
 */
export function createLaneEventWatch(visible: (state: Int32Array, body: number) => boolean): LaneEventWatch {
  let seen = -1;
  let current: LaneEventKind | null = null;
  let shown: { readonly kind: LaneEventKind; readonly from: number } | null = null;
  return {
    see(state) {
      const tick = state[HEADER.tick] as number;
      if (tick < seen) {
        current = null;
        shown = null;
      }
      seen = tick;
      let inView: LaneEventKind | null = null;
      const count = state[HEADER.bodyCount] as number;
      for (let body = 0; body < count && inView === null; body += 1) {
        const base = bodyBase(body);
        // Bonus je sbíraná věc (catch, slice, defense) nebo cíl (whack); HP jiných rolí je zdraví, ne značka.
        const role = state[base + BODY.role];
        if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || (role !== ROLE.collectible && role !== ROLE.target)) continue;
        const kind = eventOfMark(bodyHp(state, body));
        if (kind !== null && visible(state, body)) inView = kind;
      }
      if (inView !== null && inView !== current) shown = { kind: inView, from: tick };
      current = inView;
      return shown !== null && tick - shown.from < PACING_BANNER_TICKS ? shown.kind : null;
    },
  };
}

/** Co je u pruhového žánru „v obraze“, podle jeho pravidla; žánr bez událostí → `null` (banner se nekreslí). */
export function laneEventViewOf(rules: ArcadeWorld['rules']): ((state: Int32Array, body: number) => boolean) | null {
  if (nativeRule(rules, 'catch_fall') !== undefined) return catchInView;
  if (nativeRule(rules, 'whack_hit') !== undefined) return whackInView;
  if (nativeRule(rules, 'defense_hit') !== undefined) return defenseInView;
  if (nativeRule(rules, 'slice_cut') !== undefined) return sliceInView;
  return null;
}

export function LaneEventBanner({ session, enabled, visible }: {
  readonly session: Pick<ArcadeSession, 'state' | 'subscribe'>;
  readonly enabled: boolean;
  readonly visible: (state: Int32Array, body: number) => boolean;
}) {
  const [watch] = useState(() => createLaneEventWatch(visible));
  const read = (): LaneEventKind | null => watch.see(session.state());
  const kind = useSyncExternalStore(session.subscribe, read, read);
  if (!enabled || kind === null) return null;
  return (
    <p key={kind} className="sp-world-tag play-pacing-banner play-lane-event" data-testid="play-lane-event" data-event={kind} role="status">
      {LANE_EVENT_LABELS[kind]}
    </p>
  );
}
