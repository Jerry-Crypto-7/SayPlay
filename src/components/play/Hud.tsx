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

import { useEffect, useState } from 'react';

import { readVariable, type RuntimeSnapshot } from '@/worldstream/runtime-controller';
// `timer.ts` importuje jen typy, takže konstanta runtime bundl nezatíží.
import { TICKS_PER_SECOND } from '@/play/compile/adapters/timer';
import type { GameSpecV1 } from '@/play/spec';

import { MuteButton } from './MuteButton';
import { ShareButton } from './ShareButton';

export { TICKS_PER_SECOND };

/** Uplynulý čas pro hráče (P28B F-15): „28.1 s“, nikdy tiky. */
export const secondsOf = (tick: number, hz: number): string => `${(tick / hz).toFixed(1)} s`;

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
export function timerLeft(spec: GameSpecV1, elapsedSeconds: number): string | null {
  const timer = spec.mechanics.find((entry) => entry.id === 'timer');
  const seconds = timer?.params.seconds;
  return typeof seconds === 'number' ? `${Math.max(0, seconds - elapsedSeconds)}s left` : null;
}

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

/** Náhradní vstupy za „nebo“ – výzva jmenuje jen první („Tap or Space“ → „Tap“). */
const ALTERNATIVE_INPUT = /\s+or\s+(?:space|arrows|a\/d|w\/s|down|up|enter|keys|tap|swipe|click|drag)\b/gi;

/**
 * Výzva prvních sekund (P28C T5): nápověda ovládání zkrácená na jeden povel –
 * první věta, první souvětí, bez náhradních kláves. U „Tap a mushroom to walk
 * to it“ zůstane jen to, na co klepnout („Tap a mushroom“). Žádný nový text:
 * jen slova, která hra už v nápovědě má.
 */
export function callToAction(controlsHint: string): string {
  const sentence = controlsHint.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  let clause = (sentence.split(/[,;]/)[0] ?? '').replace(/[.!?]+$/, '').replace(ALTERNATIVE_INPUT, '').trim();
  // Povel s předmětem („Tap a/the …“) končí předmětem: „to walk to it“, „when the lava is calm“ je už návod.
  if (/^\w+\s+(?:a|an|the)\s/i.test(clause)) clause = clause.split(/\s+(?:to|when|and)\s+/i)[0] ?? clause;
  return clause;
}

const FIRST_PROMPT_MS = 4000;

/**
 * Velká výzva uprostřed (P28C T5): zmizí po prvním vstupu hráče – klepnutí,
 * klávesa mimo pole formuláře – nebo po 4 s. Menší nápověda v HUD zůstává.
 */
export function FirstPrompt({ controlsHint }: { readonly controlsHint: string }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const hide = (): void => setShown(false);
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)) return;
      hide();
    };
    const timer = window.setTimeout(hide, FIRST_PROMPT_MS);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const text = callToAction(controlsHint);
  if (!shown || text === '') return null;
  return (
    <p className="play-first-prompt" data-testid="play-first-prompt" aria-hidden="true">
      {text}
    </p>
  );
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
        {/* Tik hráč nevidí (P28B F-15); čas nese `progressLine`, atribut čtou e2e. */}
        <span className="play-hud-tick" data-testid="play-tick" data-tick={snapshot.tick} hidden />

      </p>
      <MuteButton />
      {snapshot.runState === 'running' && <ShareButton versionId={versionId} title={spec.title} className="play-hud-share" />}
    </header>
  );
}
