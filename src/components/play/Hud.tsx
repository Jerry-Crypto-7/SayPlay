'use client';

/**
 * HUD hry (P23-C T5): cíl jednou větou, nápověda ovládání, postup a tik.
 *
 * Postup se čte ze snímku runtime podle druhu cíle ve specu: sbírání,
 * brány a poražení jsou čítač `N/M`, přežití je odpočet ze `tick/20`,
 * ostatní ukazují uplynulý čas. Jména čítačů jsou ta, která zapisují
 * adaptéry kompilátoru (`collectible.params.counter`, `GATES_COUNTER`,
 * `DEFEATED_COUNTER` v `src/play/compile/adapters/**`) – tady opsaná, ne
 * importovaná, aby klientský bundl netáhl registr mechanik a zod.
 */

import { readVariable, type RuntimeSnapshot } from '@/worldstream/runtime-controller';
import type { GameSpecV1 } from '@/play/spec';

import { ShareButton } from './ShareButton';
import { timerLeft } from './timer';

export const TICKS_PER_SECOND = 20;

/** Čítač, který cíl hry sleduje; `null`, když cíl žádný čítač nemá. */
export function objectiveCounter(spec: GameSpecV1): string | null {
  switch (spec.objective.kind) {
    case 'collect': {
      const mechanic = spec.mechanics.find((entry) => entry.id === 'collectible' && entry.params.role === spec.objective.role);
      const counter = mechanic?.params.counter;
      return typeof counter === 'string' ? counter : 'collected';
    }
    case 'checkpoints':
      return 'gatesPassed';
    case 'defeat_targets':
      return 'defeated';
    default:
      return null;
  }
}

/**
 * Odpočet mechaniky `timer` (P26 T8): časovač od AI hráč jinak neviděl a hra
 * skončila „z ničeho nic“. `null`, když spec časovač nemá.
 */
export function progressLine(spec: GameSpecV1, snapshot: Pick<RuntimeSnapshot, 'tick' | 'values'>): string {
  const seconds = Math.floor(snapshot.tick / TICKS_PER_SECOND);
  const clock = timerLeft(spec, seconds);
  const counter = objectiveCounter(spec);
  if (counter !== null) {
    const value = readVariable(snapshot as RuntimeSnapshot, counter) ?? 0;
    return `${value} / ${spec.objective.count ?? 1}${clock === null ? '' : ` · ${clock}`}`;
  }
  if (spec.objective.kind === 'survive') {
    const remaining = Math.max(0, (spec.objective.seconds ?? 0) - seconds);
    return `${remaining}s left`;
  }
  return clock ?? `${seconds}s`;
}

/**
 * Fáze světla (P25D T1): hra „červená–zelená“ prohraje krok v červené, ale
 * barva je jen flag ve stavu – bez tohohle řádku hráč nevidí, kdy stát.
 * Jméno flagu skládá `timer.ts` jako `<id>_red`; tady opsané ze stejného
 * důvodu jako jména čítačů výš.
 */
export function phaseLine(spec: GameSpecV1, snapshot: Pick<RuntimeSnapshot, 'values'>): string | null {
  const timer = spec.mechanics.find((entry) => entry.id === 'timer' && entry.params.phases !== undefined);
  if (timer === undefined || typeof timer.params.id !== 'string') return null;
  return readVariable(snapshot as RuntimeSnapshot, `${timer.params.id}_red`) === 1 ? 'RED – freeze' : 'GREEN – go';
}

/** Sdílení během hry (P27B T5); po dohrání ho nese `PostRun`, ať nejsou na stránce dvě. */
export function Hud({ spec, snapshot, versionId }: { readonly spec: GameSpecV1; readonly snapshot: RuntimeSnapshot; readonly versionId: string }) {
  const phase = phaseLine(spec, snapshot);
  return (
    <header className="play-hud" aria-label="Game status">
      <h1 className="play-hud-title">{spec.title}</h1>
      <p className="play-hud-goal" data-testid="play-goal">{spec.tutorial.goalLine}</p>
      <p className="play-hud-hint">{spec.tutorial.controlsHint}</p>
      {phase === null ? null : (
        <p className={phase.startsWith('RED') ? 'play-hud-phase play-hud-phase-red' : 'play-hud-phase play-hud-phase-green'} data-testid="play-phase">
          {phase}
        </p>
      )}
      <p className="play-hud-progress">
        <span data-testid="play-progress">{progressLine(spec, snapshot)}</span>
        <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick}>
          tick {snapshot.tick}
        </span>
      </p>
      {snapshot.runState === 'running' && <ShareButton versionId={versionId} title={spec.title} className="play-hud-share" />}
    </header>
  );
}
