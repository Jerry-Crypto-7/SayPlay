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

import type { ReactNode } from 'react';

import { readVariable, type RuntimeSnapshot } from '@/worldstream/runtime-controller';
// `timer.ts` importuje jen typy, takže konstanta runtime bundl nezatíží.
import { TICKS_PER_SECOND } from '@/play/compile/adapters/timer';
import type { GameSpecV1 } from '@/play/spec';

import type { RunFacts } from './PostRun';
import { timerLeft } from './timer';
import { GameHud, type HudClock, type HudGoal, objectiveShown } from './ui';

export { TICKS_PER_SECOND };

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

/** Popisek počítadla cíle pro `data-testid="hud-counter-…"` (seznam `e2e/hud-labels.ts`). */
const GOAL_LABEL: Readonly<Partial<Record<GameSpecV1['objective']['kind'], string>>> = {
  collect: 'collected',
  checkpoints: 'gate',
  defeat_targets: 'defeated',
};

/** Cílové předměty mřížky (`3/5`) pro pilulku postupu i výsledek; `null`, když cíl žádný čítač nemá. */
export function gridGoal(spec: GameSpecV1, snapshot: RuntimeSnapshot): HudGoal | null {
  const counter = objectiveCounter(spec);
  const label = GOAL_LABEL[spec.objective.kind];
  return counter === null || label === undefined ? null : { label, count: readVariable(snapshot, counter) ?? 0, need: spec.objective.count ?? 1 };
}

/** Čítač zásahů mechaniky `health` (`DAMAGE_COUNTER` v `adapters/health.ts`), opsaný jako jména výš. */
const DAMAGE = 'damage';
/** Co hráče chytí nebo zraní; bez `health` je každý zásah rovnou prohra. */
const CATCHERS: ReadonlySet<string> = new Set(['chaser', 'patrol']);
const THREATS: ReadonlySet<string> = new Set([...CATCHERS, 'hazard_zone']);

/**
 * Fakta skončeného běhu mřížky pro výsledek (P34 T6): cíl, zásahy a čas.
 * Zásahy počítá čítač `health`; hra bez něj končí prohrou při prvním
 * chycení, takže výhra v ní je skutečná nula – prohra bez něj číslo nemá.
 */
export function gridFacts(spec: GameSpecV1, snapshot: RuntimeSnapshot): RunFacts {
  const won = snapshot.runState === 'won';
  const goal = gridGoal(spec, snapshot);
  const health = spec.mechanics.some((entry) => entry.id === 'health');
  const threat = spec.mechanics.some((entry) => THREATS.has(entry.id));
  const hits = health ? (readVariable(snapshot, DAMAGE) ?? 0) : threat && won ? 0 : null;
  return {
    won,
    tick: snapshot.tick,
    hz: TICKS_PER_SECOND,
    survive: spec.objective.kind === 'survive',
    goal: goal === null ? null : { ...goal, label: goal.label === 'gate' ? 'gates' : goal.label },
    extra: hits === null ? [] : [{ value: String(hits), label: spec.mechanics.some((entry) => CATCHERS.has(entry.id)) ? 'times caught' : 'times hit' }],
  };
}

/** Čas mřížky: odpočet hry na přežití nebo mechaniky `timer`, jinak uběhlý čas. */
export function gridClock(spec: GameSpecV1, tick: number): HudClock {
  const elapsed = tick / TICKS_PER_SECOND;
  const timer = spec.mechanics.find((entry) => entry.id === 'timer')?.params.seconds;
  const limit = spec.objective.kind === 'survive' ? spec.objective.seconds : typeof timer === 'number' ? timer : undefined;
  return limit === undefined ? { seconds: elapsed, countdown: false } : { seconds: limit - elapsed, countdown: true };
}

/**
 * HUD mřížky podle kitu (P34 T5, dřív tenký pruh P33 T12): postup cíle
 * s ikonami, časovač, pauza a řádek cíle; dolní řadu a lištu cílů posílá
 * `GridShell`. Text postupu (`progressLine`) dostane čtečka.
 */
export function Hud({
  spec,
  snapshot,
  paused,
  onPause,
  bottom,
  children,
}: {
  readonly spec: GameSpecV1;
  readonly snapshot: RuntimeSnapshot;
  readonly paused: boolean;
  readonly onPause?: () => void;
  readonly bottom?: ReactNode;
  readonly children?: ReactNode;
}) {
  const phase = phaseLine(spec, snapshot);
  return (
    <GameHud
      title={spec.title}
      goalLine={spec.tutorial.goalLine}
      goal={gridGoal(spec, snapshot)}
      clock={gridClock(spec, snapshot.tick)}
      objective={snapshot.runState === 'running' && objectiveShown(snapshot.tick, TICKS_PER_SECOND, paused)}
      keepGoal={snapshot.runState === 'running'}
      onPause={onPause}
      status={
        <p className="play-sr-only">
          <span data-testid="play-progress">{progressLine(spec, snapshot)}</span>
          {/* Tik hráč nevidí (P28B F-15); čas nese časovač, atribut čtou e2e. */}
          <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick} hidden />
        </p>
      }
      phase={
        phase === null ? null : (
          <p className={phase.startsWith('RED') ? 'play-hud-phase play-hud-phase-red' : 'play-hud-phase play-hud-phase-green'} data-testid="play-phase">
            {phase}
          </p>
        )
      }
      bottom={bottom}
    >
      {children}
    </GameHud>
  );
}
