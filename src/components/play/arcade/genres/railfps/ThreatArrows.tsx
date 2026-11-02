'use client';

/**
 * Ukazatele hrozby mimo záběr (P68-F T9). Na výšku kamera ukáže jen ~2,4 z 9 sektorů, takže nepřítel z boku dojde
 * nevidět. Šipka u kraje obrazovky na straně nepřítele, který je mimo záběr a nejblíž dosahu (`RAILFPS.reach`):
 * na každé straně nejvýš jedna, tedy nejvýš 2 naráz. Kit (`08-game-hud.md`, world tag): objekt mimo obrazovku =
 * šipka u kraje, rajčatová = hrozba, neprůhledná s inkoustovým okrajem, 16 px od kraje bezpečné oblasti.
 *
 * Jen čte stav a pózu, kterou scéna právě nakreslila; nic nezapisuje. Šipka je DOM nad plátnem a ťuky propouští
 * na plátno (míření zůstává na `RailfpsTouch.tsx`). Nehýbe se sama, takže `prefers-reduced-motion` nemá co vypnout.
 */

import { type RefObject, useEffect, useRef } from 'react';

import type { ArcadeState } from '@/play/arcade/contract';
import { YAW, foeDistance, foeSector, foesOf, isEnemy } from '@/play/arcade/pieces/railfps-world';

import type { PlayRect } from '../../portrait-frame';
import { sectorToScreen } from './railfps-camera';

export type ThreatSide = 'left' | 'right';

export interface Threat {
  readonly side: ThreatSide;
  readonly body: number;
  readonly sector: number;
  /** Vzdálenost po paprsku sektoru (jednotky jádra). */
  readonly distance: number;
}

/**
 * Hrozby mimo záběr: živí nepřátelé (i boss), jejichž sektor kamera s natočením `yawDeg`, poměrem `aspect` a polem
 * `fovDeg` nekreslí (`sectorToScreen` je `null`; nepřítel jde po paprsku středu sektoru). Na každé straně ten nejblíž
 * dosahu, při shodě nižší tělo; seřazené od nejbližšího. `coming` = přepadení, která teprve vzniknou (`rushesAhead`):
 * šipka je ohlásí předem (tělo −1), ať se člověk stihne natočit.
 */
export function offscreenThreats(state: ArcadeState, yawDeg: number, aspect: number, fovDeg: number, coming: readonly { readonly sector: number; readonly distance: number }[] = []): Threat[] {
  const nearest = new Map<ThreatSide, Threat>();
  const consider = (body: number, sector: number, distance: number): void => {
    if (sectorToScreen(sector, yawDeg, aspect, fovDeg) !== null) return;
    const side: ThreatSide = sector * YAW.stepDeg < yawDeg ? 'left' : 'right';
    const held = nearest.get(side);
    if (held === undefined || distance < held.distance || (distance === held.distance && body < held.body)) nearest.set(side, { side, body, sector, distance });
  };
  for (const body of foesOf(state)) if (isEnemy(state, body)) consider(body, foeSector(state, body), foeDistance(state, body));
  for (const rush of coming) consider(-1, rush.sector, rush.distance);
  return [...nearest.values()].sort((a, b) => a.distance - b.distance || a.body - b.body);
}

/** Šipka (hrot vlevo) se zářezem; pravá je zrcadlo. Výřez, ne obrázek. */
const DART: Readonly<Record<ThreatSide, string>> = {
  left: 'polygon(0 50%,100% 4%,76% 50%,100% 96%)',
  right: 'polygon(100% 50%,0 4%,24% 50%,0 96%)',
};
const EDGE: Readonly<Record<ThreatSide, string>> = {
  left: 'left:calc(var(--sp-space-4) + env(safe-area-inset-left, 0px));',
  right: 'right:calc(var(--sp-space-4) + env(safe-area-inset-right, 0px));',
};

export interface ThreatOverlay {
  /** Ukáže šipky hrozeb ve výšce horizontu oka (střed pásu hry); ostatní schová. */
  paint(threats: readonly Threat[], rect: PlayRect): void;
  remove(): void;
}

/** Dvě šipky na ploše hry (skryté); píše se jen to, co se změnilo. */
export function mountThreatArrows(host: HTMLElement): ThreatOverlay {
  const arrows = (['left', 'right'] as const).map((side) => {
    const element = document.createElement('div');
    element.dataset.testid = `railfps-threat-${side}`;
    element.setAttribute('aria-hidden', 'true');
    element.style.cssText = `position:absolute;pointer-events:none;z-index:1;${EDGE[side]}width:var(--sp-size-touch-min);height:var(--sp-size-touch-min);margin-top:calc(var(--sp-size-touch-min) / -2);background:var(--sp-color-ink);clip-path:${DART[side]};`;
    const fill = document.createElement('div');
    fill.style.cssText = `position:absolute;inset:var(--sp-space-1);background:var(--sp-color-tomato);clip-path:${DART[side]};`;
    element.append(fill);
    element.hidden = true;
    host.append(element);
    return { side, element };
  });
  return {
    paint(threats, rect) {
      const top = `${String(Math.round((rect.px.top + rect.px.bottom) / 2))}px`;
      for (const { side, element } of arrows) {
        const threat = threats.find((entry) => entry.side === side);
        if (element.hidden !== (threat === undefined)) element.hidden = threat === undefined;
        if (threat === undefined) continue;
        if (element.style.top !== top) element.style.top = top;
        const sector = String(threat.sector);
        if (element.dataset.sector !== sector) element.dataset.sector = sector;
      }
    },
    remove() {
      for (const { element } of arrows) element.remove();
    },
  };
}

/** Šipky na ploše hry `surface` po dobu montáže scény; scéna je kreslí ve svém snímku po pozici kamery. */
export function useThreatArrows(surface: RefObject<HTMLDivElement | null>): RefObject<ThreatOverlay | null> {
  const overlay = useRef<ThreatOverlay | null>(null);
  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    const made = mountThreatArrows(host);
    overlay.current = made;
    return () => {
      made.remove();
      overlay.current = null;
    };
  }, [surface]);
  return overlay;
}
