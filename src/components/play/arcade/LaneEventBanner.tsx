/**
 * Ohlášení událostí pruhových žánrů (P55 T5): když se v obraze poprvé ukáže bonus nové události, štítek kitu
 * `sp-world-tag` pod bannerem průběhu řekne, co přišlo – „Bonus run!“, „Gold!“, „Rush!“ – na 1,4 s herního času.
 * Událost se pozná podle značky v HP těla (`EVENT_MARK`); co je „v obraze“, ví žánr (`visible`). Banner nic
 * nepočítá do stavu: čte stav po tiku a drží, co už ukázal. Restart (tik zpět) začne znovu.
 */

import { useState, useSyncExternalStore } from 'react';

import { BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp } from '@/play/arcade/contract';
import { type LaneEventKind, eventOfMark } from '@/play/arcade/pieces/lane-events';

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
        if (((state[base + BODY.flags] as number) & FLAG.alive) === 0 || state[base + BODY.role] !== ROLE.collectible) continue;
        const kind = eventOfMark(bodyHp(state, body));
        if (kind !== null && visible(state, body)) inView = kind;
      }
      if (inView !== null && inView !== current) shown = { kind: inView, from: tick };
      current = inView;
      return shown !== null && tick - shown.from < PACING_BANNER_TICKS ? shown.kind : null;
    },
  };
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
