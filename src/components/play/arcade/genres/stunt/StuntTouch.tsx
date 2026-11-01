'use client';

/**
 * DOM nad plátnem závodu s triky (P68V T4): palec a počítadla hry.
 *
 * **`StuntTouch`** – plocha přes spodní polovinu scény (tah vlevo / vpravo = osa) a tlačítko brzdy vpravo dole
 * (`.sp-btn--primary`, jediná rajčatová akce obrazovky, místo a velikost `.play-fire` = kolo palce nad dolní řadou HUD,
 * ≥ `--sp-size-touch-min`). Gesta překládá čistá `stunt-touch.ts` na tentýž `ArcadeInput` jako šipky a S / ↓; relace
 * dostane jen `session.hold` a `session.holdButtons`, záznam ani replay se nemění. Plocha hry (`useSteerInput` pro vstup
 * `steer`) poslouchá ukazatel nativně na celé ploše – posluchače tady proto prst zastaví, ať týž prst neřídí dvakrát.
 * Klávesnici dál drží `useSteerInput`; nad horní polovinou scény řídí prst jeho tah jako dřív (tatáž sémantika).
 * Props jako `GenreTouchProps` (`genres/touch-registry.ts`), ať ji P68-I může zapsat do `GENRE_TOUCH`.
 *
 * **`StuntCounters`** – pilulka `Smash` (rozbité krabice) a `Air` (skoky) vlevo dole: HUD (`ArcadePlay`, sdílený) čítače
 * hry z počítadla nezná. Popisky `hud-counter-smash` / `hud-counter-air` jsou v `hud-labels-request.ts`.
 *
 * Obojí montuje `StuntScene` do plochy hry (šev P68-I T1), dokud ji nemontuje sdílený kód.
 */

import { type CSSProperties, useEffect, useRef, useSyncExternalStore } from 'react';

import { BUTTON } from '@/play/arcade/contract';
import { stuntCounter } from '@/play/arcade/pieces/stunt-track';

import type { ArcadeSession } from '../../session';
import { type StuntTouchZone, stuntTouch } from './stunt-touch';

/** Spodní polovina scény; průhledná – nic nekreslí, jen chytá prst. */
const PAD: CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: 0, height: '50%', pointerEvents: 'auto' };
/** Kolo palce `.play-fire` s popiskem: bez vnitřního okraje tlačítka kitu, písmo střední velikosti. */
const BRAKE: CSSProperties = { padding: 0, fontSize: 'var(--sp-text-button-m-size)', pointerEvents: 'auto' };
/** Vlevo dole nad dolní řadou HUD (`--_stack`), naproti brzdě; prst pod ní řídí dál. */
const COUNTERS: CSSProperties = { position: 'absolute', left: 'var(--_side-l, var(--sp-space-3))', bottom: 'var(--_stack, var(--sp-space-4))', margin: 0, pointerEvents: 'none' };

const POINTER_END = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;

export function StuntTouch({ session }: { readonly session: ArcadeSession }) {
  const pad = useRef<HTMLDivElement | null>(null);
  const brake = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const surface = pad.current;
    const button = brake.current;
    if (surface === null || button === null) return;
    const touch = stuntTouch();
    const sync = (): void => {
      const input = touch.input();
      session.hold(input.axis);
      session.holdButtons(input.buttons);
      // Pro oko e2e a stisknutý vzhled: co adaptér právě drží.
      surface.dataset.axis = String(input.axis);
      button.classList.toggle('is-pressed', (input.buttons & BUTTON.DOWN) !== 0);
    };
    const bind = (element: HTMLElement, zone: StuntTouchZone): (() => void) => {
      const down = (event: PointerEvent): void => {
        event.stopPropagation();
        // Prst, který vyjede z plochy, se musí pustit i venku – jinak řízení zůstane vytočené.
        element.setPointerCapture(event.pointerId);
        touch.down(event.pointerId, event.clientX, zone);
        sync();
      };
      const move = (event: PointerEvent): void => {
        // Najetí myší bez stisku není tah: relaci by přepsalo osu kláves.
        if (!element.hasPointerCapture(event.pointerId)) return;
        event.stopPropagation();
        touch.move(event.pointerId, event.clientX);
        sync();
      };
      const end = (event: PointerEvent): void => {
        event.stopPropagation();
        if (!touch.active()) return;
        touch.up(event.pointerId);
        sync();
      };
      element.addEventListener('pointerdown', down);
      element.addEventListener('pointermove', move);
      for (const type of POINTER_END) element.addEventListener(type, end);
      return () => {
        element.removeEventListener('pointerdown', down);
        element.removeEventListener('pointermove', move);
        for (const type of POINTER_END) element.removeEventListener(type, end);
      };
    };
    const unbind = [bind(surface, 'steer'), bind(button, 'brake')];
    const release = (): void => {
      if (!touch.active()) return;
      touch.clear();
      sync();
    };
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('blur', release);
      for (const off of unbind) off();
      release();
    };
  }, [session]);
  return (
    <>
      <div ref={pad} data-testid="stunt-touch" data-axis="0" style={PAD} aria-hidden="true" />
      <button ref={brake} type="button" className="sp-btn sp-btn--primary play-fire" data-testid="stunt-brake" style={BRAKE}>
        Brake
      </button>
    </>
  );
}

export function StuntCounters({ session }: { readonly session: ArcadeSession }) {
  const smash = useSyncExternalStore(session.subscribe, () => stuntCounter(session.state(), 'smash'), () => 0);
  const air = useSyncExternalStore(session.subscribe, () => stuntCounter(session.state(), 'jumps'), () => 0);
  return (
    <p className="sp-hud-pill" data-testid="stunt-counters" style={COUNTERS}>
      <span className="play-hud-count" data-testid="hud-counter-smash" data-count={smash}>
        Smash<span className="play-hud-num">{smash}</span>
      </span>
      <span className="play-hud-count" data-testid="hud-counter-air" data-count={air}>
        Air<span className="play-hud-num">{air}</span>
      </span>
    </p>
  );
}
