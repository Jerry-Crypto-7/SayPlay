'use client';

/**
 * Pauza hry podle kitu Sayplay (P34 T5, `08-game-hud.md` Pause overlay):
 * scrim inkoustu 45 % přes hru a karta uprostřed – Resume (jediná rajčatová
 * akce), Restart, Change one thing a pod nimi řádek menších tlačítek, který
 * skládá shell (Sound, About this game, Show me how, Quit). Karta drží fokus,
 * Esc a klepnutí mimo ji zavřou a hru pustí (`holdSheet`).
 *
 * Klávesy hry mapuje čistá funkce `hudKey` (test `__tests__/hud-keys.test.ts`):
 * Space pauza, R restart, Esc zavřít, M zvuk – nikdy při psaní do pole.
 */

import { type ReactNode, useEffect, useId, useRef } from 'react';

import { isTyping } from '../arcade/input';
import { touchHint, useCoarsePointer } from '../FirstPrompt';
import { CHANGE_ONE_THING } from '../starters';
import { Button } from './Button';
import { Icon } from './icons';
import { holdSheet } from './Sheet';

/** Popisek „Change one thing“ – od P34 T6 je konstanta v `starters.ts` rovnou ve větném tvaru. */
export const CHANGE_LABEL = CHANGE_ONE_THING;

export type HudKeyAction = 'pause' | 'resume' | 'restart' | 'mute';

export interface HudKeyState {
  /** Hra stojí v pauze (karta je otevřená). */
  readonly paused: boolean;
  /**
   * Mezerník už použila hra (skok, výstřel, sebrání vybrané karty) – hry
   * volají `preventDefault` na klávesy, které hrají, jako u šipek feedu.
   */
  readonly spaceIsGameKey: boolean;
}

export type HudKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>;

/** Mezerník na tlačítku nebo odkazu ho zmáčkne – to není pauza. */
export const onControl = (target: EventTarget | null): boolean => target instanceof HTMLElement && target.closest('button, a[href], summary, [role="button"]') !== null;

/**
 * Klávesa HUD → akce, nebo `null`. Esc kartu zavře, bez karty ji otevře
 * (kit: Esc = close sheet / exit game – odchod z hry je Quit na kartě).
 * `mute` obslouží zvuk hry sám (`installSoundControls`, jeden posluchač pro
 * celou stránku) – HUD klávesu M jen drží pro zvuk.
 */
export function hudKey(event: HudKeyEvent, state: HudKeyState): HudKeyAction | null {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return null;
  const key = event.key.toLowerCase();
  if (key === 'escape') return state.paused ? 'resume' : 'pause';
  if (key === 'r') return 'restart';
  if (key === 'm') return 'mute';
  if (key !== ' ' || onControl(event.target)) return null;
  if (state.paused) return 'resume';
  return state.spaceIsGameKey ? null : 'pause';
}

/**
 * Klávesy HUD, dokud `enabled`. Poslouchá v zachytávací fázi, tedy dřív, než
 * Esc zavře kartu (`holdSheet`) – jinak by stejný stisk kartu zavřel a hned
 * znovu otevřel. Mezerník, který by pauzu jen zapnul, se rozhodne až po
 * doběhnutí události – teprve pak je vidět, jestli ho vzala hra
 * (`defaultPrevented`). `mute` se tu nedělá (viz `hudKey`).
 */
export function useHudKeys(enabled: boolean, paused: () => boolean, act: (action: Exclude<HudKeyAction, 'mute'>) => void): void {
  const latest = useRef({ paused, act });
  useEffect(() => {
    latest.current = { paused, act };
  });
  useEffect(() => {
    if (!enabled) return;
    let later: ReturnType<typeof setTimeout> | undefined;
    const onKey = (event: KeyboardEvent): void => {
      const action = hudKey(event, { paused: latest.current.paused(), spaceIsGameKey: false });
      if (action === null || action === 'mute') return;
      if (action !== 'pause' || event.key !== ' ') {
        if (event.key === ' ') event.preventDefault();
        latest.current.act(action);
        return;
      }
      later = setTimeout(() => {
        if (hudKey(event, { paused: latest.current.paused(), spaceIsGameKey: event.defaultPrevented }) === 'pause') latest.current.act('pause');
      }, 0);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(later);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enabled]);
}

/** Klávesy, kterými se mačká tlačítko na kartě. */
const PRESS_KEYS = new Set([' ', 'Enter']);

export function PauseCard({
  onResume,
  onRestart,
  onChange,
  controlsHint,
  touch,
  children,
}: {
  readonly onResume: () => void;
  readonly onRestart: () => void;
  /** „Change one thing“; bez něj (hra změnu teď neumí) tlačítko není. */
  readonly onChange?: () => void;
  /** Nápověda ovládání hry – na dotyku bez kláves (`touchHint`), s myší celá. */
  readonly controlsHint?: string;
  /** Nápověda pro dotyk tam, kde ji text hry neřekne (zóny plošinovky, `ZONE_HINTS`). */
  readonly touch?: string;
  /** Řádek menších tlačítek pod hlavními akcemi. */
  readonly children?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const coarse = useCoarsePointer();
  // Rodič posílá novou funkci při každém vykreslení; karta se kvůli tomu nesmí znovu připojit (fokus by skákal).
  const latestResume = useRef(onResume);
  useEffect(() => {
    latestResume.current = onResume;
  });
  useEffect(() => {
    const element = panel.current;
    if (element === null) return;
    // Mezerník a Enter na kartě mačkají její tlačítko. Hra je poslouchá na `window` a volá
    // `preventDefault` (skok), čímž by stisk tlačítka zrušila – na kartě dál nedojdou.
    const keep = (event: KeyboardEvent): void => {
      if (PRESS_KEYS.has(event.key)) event.stopPropagation();
    };
    element.addEventListener('keydown', keep);
    const release = holdSheet(document, element, () => latestResume.current());
    return () => {
      element.removeEventListener('keydown', keep);
      release();
    };
  }, []);

  return (
    <div className="sp-scrim play-pause">
      <div ref={panel} className="sp-card play-pause-card" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="play-paused" tabIndex={-1}>
        <h2 id={titleId} className="sp-title-l play-pause-title">
          Paused
        </h2>
        {controlsHint !== undefined && controlsHint !== '' && (
          <p className="play-pause-hint" data-testid="play-controls">
            {coarse ? (touch ?? touchHint(controlsHint)) : controlsHint}
          </p>
        )}
        <Button size="l" className="sp-btn--block" data-testid="play-resume" title="Resume (Esc)" onClick={onResume}>
          Resume
        </Button>
        <Button variant="secondary" className="sp-btn--block" data-testid="play-restart" title="Restart (R)" onClick={onRestart}>
          <Icon name="restart" />
          Restart
        </Button>
        {onChange !== undefined && (
          <Button variant="secondary" className="sp-btn--block play-change" data-testid="play-pause-change" aria-haspopup="dialog" onClick={onChange}>
            <Icon name="wand" />
            {CHANGE_LABEL}
          </Button>
        )}
        {children !== undefined && <div className="play-pause-more">{children}</div>}
      </div>
    </div>
  );
}
