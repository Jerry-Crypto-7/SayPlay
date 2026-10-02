/**
 * HUD hry podle kitu Sayplay (P34 T5, `docs/brand/docs/08-game-hud.md`),
 * společný mřížce (`Hud.tsx`) i arkádě (`ArcadePlay.tsx`); co ukázat, počítá
 * každý shell ze svého stavu. Vrstva `.sp-hud` leží nad scénou (na desktopu
 * přesně na scéně 16:9), ťuky pouští skrz a její kusy stojí v rozích:
 * vlevo nahoře postup (ikony cílových předmětů a `3/5`), vpravo časovač
 * a pauza, pod tím řádek cíle a dole restart, „Change one thing“ a sdílení.
 * Prostřední třetina zůstává volná. Plochy jsou neprůhledné, HUD je DOM,
 * nic z něj se nekreslí do WebGL.
 */

import type { ReactNode } from 'react';

import { Icon, type IconName } from './icons';

/** Cílové předměty: `label` jde do `data-testid="hud-counter-…"` (seznam `e2e/hud-labels.ts`). */
export interface HudGoal {
  readonly label: string;
  readonly count: number;
  readonly need: number;
}

/** Další skutečné počítadlo hry (životy, rány, náboje) – jen tam, kde ho hra má. */
export interface HudCounter {
  readonly label: string;
  readonly count: number;
  readonly text: string;
  readonly icon?: IconName;
  /** Právě překonaný rekord (P36B T4): položka vyskočí jako sebrané vejce. */
  readonly fresh?: boolean;
}

/** Čas běhu: uběhlý, nebo odpočet (hra na přežití, časový limit). */
export interface HudClock {
  readonly seconds: number;
  readonly countdown: boolean;
}

/** Časovač kitu: `14.2s` – desetiny, bez mezery, nikdy pod nulou. */
export const clockText = (seconds: number): string => `${Math.max(0, seconds).toFixed(1)}s`;

/** Odpočet pod 5 s zrajčatí (kit: survive games turn tomato under 5s). */
export const clockLow = (clock: HudClock): boolean => clock.countdown && clock.seconds < 5;

/** Řádek cíle je vidět prvních tolik sekund hry. */
export const OBJECTIVE_SECONDS = 4;

/**
 * Je řádek cíle vidět? Prvních `OBJECTIVE_SECONDS` hry – hodiny stojí, dokud
 * se hráč nedotkne, takže cíl čte i ten, kdo váhá – a znovu při pauze.
 */
export function objectiveShown(tick: number, hz: number, paused: boolean): boolean {
  return paused || tick < OBJECTIVE_SECONDS * hz;
}

/** Víc cílů než tolik ukáže jen počet – řada ikon by pilulku protáhla přes roh. */
const MAX_EGGS = 6;

/** Vejce kitu: sebrané slunečné, zbývající čárkované; sebrání ho vyskočí (`sp-pop-in`). */
function Egg({ collected }: { readonly collected: boolean }) {
  return (
    <svg className={collected ? 'sp-egg is-collected' : 'sp-egg'} viewBox="0 0 18 22" aria-hidden="true" focusable="false">
      <ellipse cx="9" cy="12" rx="7" ry="9" />
    </svg>
  );
}

function Goal({ goal }: { readonly goal: HudGoal }) {
  const eggs = goal.need <= MAX_EGGS ? Array.from({ length: goal.need }, (_, index) => index < goal.count) : [goal.count > 0];
  return (
    <span className="play-hud-count" data-testid={`hud-counter-${goal.label}`} data-count={goal.count}>
      {eggs.map((collected, index) => (
        <Egg key={index} collected={collected} />
      ))}
      <span className="play-hud-num">
        {goal.count}/{goal.need}
      </span>
      <span className="play-sr-only"> {goal.label}</span>
    </span>
  );
}

export function GameHud({
  title,
  heading = 'h1',
  goalLine,
  goal = null,
  counters = [],
  clock,
  objective,
  caught = false,
  onPause,
  status,
  phase,
  bottom,
  children,
}: {
  readonly title: string;
  /** Na `/play` (feed, ukázka) má stránka svou h1 nad polem, název hry je h2 (P33 T13). */
  readonly heading?: 'h1' | 'h2';
  readonly goalLine: string;
  readonly goal?: HudGoal | null;
  readonly counters?: readonly HudCounter[];
  readonly clock: HudClock;
  /** Řádek cíle je vidět (`objectiveShown`). */
  readonly objective: boolean;
  /** Hráče právě chytili: okraj pilulky postupu (bez ní časovače) na chvíli zrajčatí. */
  readonly caught?: boolean;
  /** Kulaté tlačítko pauzy; bez něj (ukázka robota, konec hry) tlačítko není. */
  readonly onPause?: () => void;
  /** Stav hry pro čtečku (text, který dřív nesl pruh nahoře). */
  readonly status?: ReactNode;
  readonly phase?: ReactNode;
  /** Dolní řada: restart, „Change one thing“, sdílení. */
  readonly bottom?: ReactNode;
  /** Další kusy vrstvy (lišta cílů, stav AI verze, pole změny) – stojí nad dolní řadou. */
  readonly children?: ReactNode;
}) {
  const Title = heading;
  const pill = goal !== null || counters.length > 0;
  const flash = (piece: string, on: boolean): string => (on ? `${piece} is-caught` : piece);
  return (
    <div className="sp-hud play-hud">
      <Title className="play-hud-title play-sr-only">{title}</Title>
      {pill && (
        <p className={flash('sp-hud-pill play-hud-progress', caught)} data-testid="play-progress-pill">
          {goal !== null && <Goal goal={goal} />}
          {counters.map((counter) => (
            <span key={counter.label} className={counter.fresh === true ? 'play-hud-count is-new' : 'play-hud-count'} data-testid={`hud-counter-${counter.label}`} data-count={counter.count}>
              {counter.icon !== undefined && <Icon name={counter.icon} />}
              <span className="play-hud-num">{counter.text}</span>
              {counter.icon === 'heart' && <span className="play-sr-only"> lives</span>}
            </span>
          ))}
        </p>
      )}
      <div className="play-hud-corner">
        <p className={flash('sp-hud-pill sp-hud-pill--sun play-hud-timer', caught && !pill)} data-testid="play-timer" data-low={clockLow(clock)} data-countdown={clock.countdown}>
          {clockText(clock.seconds)}
          {clock.countdown && <span className="play-sr-only"> left</span>}
        </p>
        {onPause !== undefined && (
          <button type="button" className="sp-hud-btn play-hud-pause" data-testid="play-pause" aria-label="Pause" title="Pause" onClick={onPause}>
            <Icon name="pause" />
          </button>
        )}
        {status}
      </div>
      <p className="sp-objective play-hud-goal" data-testid="play-goal" data-shown={objective}>
        {goalLine}
      </p>
      {phase}
      {children}
      {bottom !== undefined && bottom !== null && bottom !== false && (
        <nav className="play-hud-bottom" aria-label="Game actions">
          {bottom}
        </nav>
      )}
    </div>
  );
}
