'use client';

/**
 * Viditelné dotykové ovládání (P36C T2) – DOM nad plátnem, mimo scénu i hash.
 * `TouchZones`: zóny plošinovky a souboje se ukážou, dokud hra čeká na první
 * dotek, a ještě 3 s hry, pak zhasnou. `TouchStick`: v aréně a úkolu kroužek
 * joysticku s páčkou pod prstem – kreslí tah, který `useArenaInput` čte
 * (střed = místo dotyku, každý nový prst střed přenese, puštění vše skončí).
 * Na telefonu na výšku (P64 T7, `play.css`) stojí kroužek i v klidu na domovské pozici vlevo dole a puštění ho
 * tam vrátí; osu dál počítá jen `useArenaInput` z místa dotyku (`p64-stick.test.ts`).
 * Obojí jen na dotyku (zóny souboje i na desktopu, s klávesami); kit: papír a inkoustový obrys, žádná průhledná plocha.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useCoarsePointer } from '../FirstPrompt';
import { Icon } from '../ui/icons';
import type { ArcadeSession } from './session';
import { TICK_MS } from './session';
import type { TouchZone } from './touch-zones';

/** Jak dlouho po startu zóny visí. */
export const ZONES_MS = 3000;
const ZONES_TICKS = Math.round(ZONES_MS / TICK_MS);

/**
 * `cue` (souboj, P58C T6b): zóny visí celý běh – porotce bez nich nevěděl, čím uhnout – a slunečně svítí ta,
 * jejíž povel hra právě chce. Zóny s klávesou (`key`) se ukážou i na desktopu, s klávesou za popiskem.
 */
export function TouchZones({ session, zones, cue }: { readonly session: ArcadeSession; readonly zones: readonly TouchZone[]; readonly cue?: (state: Int32Array) => string | null }) {
  const coarse = useCoarsePointer();
  const shown = useSyncExternalStore(
    session.subscribe,
    () => session.demo() === null && (cue === undefined ? session.snapshot().tick < ZONES_TICKS : session.snapshot().runState === 'running'),
    () => false,
  );
  const lit = useSyncExternalStore(session.subscribe, () => cue?.(session.state()) ?? null, () => null);
  const keys = !coarse && zones.every((zone) => zone.key !== undefined);
  if (!coarse && !keys) return null;
  return (
    <div className="play-touch-zones" data-testid="touch-zones" data-shown={shown ? 'true' : 'false'} aria-hidden="true">
      {zones.map((zone) => {
        const on = zone.cue !== undefined && zone.cue === lit;
        return (
          <span key={`${zone.from}`} className={on ? 'sp-hud-pill sp-hud-pill--sun play-touch-zone' : 'sp-hud-pill play-touch-zone'} data-lit={on ? 'true' : undefined} style={{ left: `${((zone.from + zone.to) / 2) * 100}%` }}>
            {zone.icon !== undefined && <Icon name={zone.icon} />}
            {zone.label}
            {keys && <kbd className="play-touch-zone-key">{zone.key}</kbd>}
          </span>
        );
      })}
    </div>
  );
}

/** Nejdál, kam páčka od středu kroužku vyjede (px). */
const STICK_REACH_PX = 34;

export function TouchStick({ surface }: { readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const ring = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = surface.current;
    const base = ring.current;
    const handle = knob.current;
    if (element === null || base === null || handle === null) return;
    let origin: { readonly x: number; readonly y: number } | null = null;
    const local = (event: PointerEvent): { x: number; y: number } => {
      const box = element.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      origin = local(event);
      base.style.left = `${origin.x}px`;
      base.style.top = `${origin.y}px`;
      handle.style.transform = '';
      base.dataset.active = 'true';
    };
    const onMove = (event: PointerEvent) => {
      if (origin === null) return;
      const at = local(event);
      const dx = at.x - origin.x;
      const dy = at.y - origin.y;
      const scale = Math.min(1, STICK_REACH_PX / Math.max(1, Math.hypot(dx, dy)));
      handle.style.transform = `translate(${(dx * scale).toFixed(1)}px, ${(dy * scale).toFixed(1)}px)`;
    };
    const onUp = () => {
      origin = null;
      // Bez polohy z tahu stojí kroužek na domovské pozici z CSS (na výšku), jinde je v klidu skrytý.
      base.style.left = '';
      base.style.top = '';
      handle.style.transform = '';
      delete base.dataset.active;
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [surface]);
  return (
    <div ref={ring} className="play-stick" data-testid="touch-stick" aria-hidden="true">
      <div ref={knob} className="play-stick-knob" />
    </div>
  );
}
