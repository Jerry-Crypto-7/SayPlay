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

export function progressLine(spec: GameSpecV1, snapshot: Pick<RuntimeSnapshot, 'tick' | 'values'>): string {
  const seconds = Math.floor(snapshot.tick / TICKS_PER_SECOND);
  const counter = objectiveCounter(spec);
  if (counter !== null) {
    const value = readVariable(snapshot as RuntimeSnapshot, counter) ?? 0;
    return `${value} / ${spec.objective.count ?? 1}`;
  }
  if (spec.objective.kind === 'survive') {
    const remaining = Math.max(0, (spec.objective.seconds ?? 0) - seconds);
    return `${remaining}s left`;
  }
  return `${seconds}s`;
}

export function Hud({ spec, snapshot }: { readonly spec: GameSpecV1; readonly snapshot: RuntimeSnapshot }) {
  return (
    <header className="play-hud" aria-label="Game status">
      <h1 className="play-hud-title">{spec.title}</h1>
      <p className="play-hud-goal" data-testid="play-goal">{spec.tutorial.goalLine}</p>
      <p className="play-hud-hint">{spec.tutorial.controlsHint}</p>
      <p className="play-hud-progress">
        <span data-testid="play-progress">{progressLine(spec, snapshot)}</span>
        <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick}>
          tick {snapshot.tick}
        </span>
      </p>
    </header>
  );
}
