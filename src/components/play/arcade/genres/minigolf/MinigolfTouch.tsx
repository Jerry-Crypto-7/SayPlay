'use client';

/**
 * Natažení zpět minigolfu (P68 T8) jako DOM vrstva přes plátno: prst táhne od míčku dozadu (kdekoli v herní ploše
 * pod horním pásem HUD), puštění odpálí; šipky / A–D míří, mezerník držený nabíjí, puštěný odpálí. Obojí jde přes
 * čisté funkce `minigolf-touch.ts` do `session.hold` / `holdButtons` / `press` – týž tvar záznamu jako klávesnice.
 *
 * Kreslí jen obraz, nic z toho nejde do stavu ani hashe: gumu tahu (start → prst), měřič síly (nabití ze stavu)
 * a počet ran s parem (`hud-counter-strokes`, `hud-counter-par`) – HUD hry je dnes neukáže (popisky čítačů zná jen
 * sdílený `ArcadePlay.tsx`, prosba v README T8). Žádné akční tlačítko: rána je gesto.
 *
 * Props jako adaptér `GENRE_TOUCH` (`{ session }`), ať ho P68-I může montovat i ze `ArcadeStage`; dnes ho montuje
 * scéna (`MinigolfScene`) do kontejneru plátna, protože registr montuje jen vstup `genre`.
 */

import { useEffect, useRef } from 'react';

import { baseControlOf } from '@/play/arcade/addons';
import { type ArcadeInput, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { BALL } from '@/play/arcade/pieces/ball';
import { parOf, strokesOf } from '@/play/arcade/pieces/minigolf';
import { minigolfLayout } from '@/play/arcade/pieces/minigolf-hole';

import { isTyping } from '../../input';
import type { GenreTouchProps } from '../touch-registry';
import { minigolfCameraAxis, minigolfCourseView } from './minigolf-camera';
import { MINIGOLF_PULL, type Putt, keyPutt, pullBack, puttInput, turnAxis } from './minigolf-touch';

const LEFT_KEYS: ReadonlySet<string> = new Set(['arrowleft', 'a']);
const RIGHT_KEYS: ReadonlySet<string> = new Set(['arrowright', 'd']);

/** Spodní levý roh nad dolní řadou HUD (`--_stack` shellu), jako stav AI verze a hlášky nad ní. */
const CORNER: React.CSSProperties = { position: 'absolute', left: 'var(--_side-l, var(--sp-space-3))', margin: 0, pointerEvents: 'none' };

interface Drag {
  readonly id: number;
  /** Start a poslední poloha prstu v px vrstvy. */
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
  /** Osa kamery při stisku (`minigolfCameraAxis`): tah se měří vůči ní, ne vůči míření. */
  readonly base: number;
  released: boolean;
}

interface Keys {
  axis: number;
  left: boolean;
  right: boolean;
  /** Mezerník: nedržený, držený, puštěný (rána s nabitím `charge`, které stav měl při puštění). */
  space: 'up' | 'held' | 'released';
  charge: number;
}

export function MinigolfTouch({ session }: GenreTouchProps) {
  const layer = useRef<HTMLDivElement | null>(null);
  const band = useRef<SVGLineElement | null>(null);
  const meter = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLSpanElement | null>(null);
  const strokes = useRef<HTMLSpanElement | null>(null);
  const par = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = layer.current;
    if (element === null) return;
    let drag: Drag | null = null;
    let keys: Keys | null = null;
    let lastTick = 0;
    const course = minigolfCourseView(session.world.initial, minigolfLayout.parse(baseControlOf(session.world.control).params.layout));

    const read = () => {
      const state = session.state();
      const p = bodyBase(state[HEADER.player] as number);
      return { state, aim: state[p + BODY.aux0] as number, charge: Math.max(0, state[p + BODY.aux1] as number), tick: state[HEADER.tick] as number };
    };
    /** Vstup příštího tiku: osa a `HOLD` držené, `TAP` / `DOWN` jednou i s osou (rychlé puštění se vejde mezi tiky). */
    const send = (input: ArcadeInput): void => {
      session.hold(input.axis);
      session.holdButtons(input.buttons & BUTTON.HOLD);
      const once = input.buttons & (BUTTON.TAP | BUTTON.DOWN);
      if (once !== 0) session.press(once, input.axis);
    };
    const release = (): void => {
      session.hold(0);
      session.holdButtons(0);
    };

    const draw = (state: Int32Array, charge: number, aiming: boolean): void => {
      const line = band.current;
      if (line !== null) {
        const pulling = drag !== null && !drag.released;
        line.style.visibility = pulling ? 'visible' : 'hidden';
        if (drag !== null && pulling) {
          line.setAttribute('x1', String(drag.x0));
          line.setAttribute('y1', String(drag.y0));
          line.setAttribute('x2', String(drag.x));
          line.setAttribute('y2', String(drag.y));
        }
      }
      element.dataset.pulling = String(aiming);
      // Osa, proti které se měří příští tah (prst e2e ji čte jako `base` pro `pullFor`).
      element.dataset.axis = String(minigolfCameraAxis(state, course));
      const box = meter.current;
      if (box !== null) {
        box.style.visibility = aiming ? 'visible' : 'hidden';
        box.setAttribute('aria-valuenow', String(charge));
      }
      if (fill.current !== null) fill.current.style.width = `${String((100 * charge) / BALL.maxCharge)}%`;
      const count = strokesOf(state);
      const holePar = parOf(state);
      if (strokes.current !== null && strokes.current.dataset.count !== String(count)) {
        strokes.current.dataset.count = String(count);
        strokes.current.textContent = `${String(count)} ${count === 1 ? 'stroke' : 'strokes'}`;
      }
      if (par.current !== null && par.current.dataset.count !== String(holePar)) {
        par.current.dataset.count = String(holePar);
        par.current.textContent = `par ${String(holePar)}`;
      }
    };

    /** Po každém tiku a události ruky: vstup příštího tiku z gesta a nabití ve stavu. */
    const sync = (): void => {
      const { state, aim, charge, tick } = read();
      // Restart: gesto starého běhu nic nepošle.
      if (tick < lastTick) {
        drag = null;
        keys = null;
        release();
      }
      const elapsed = Math.max(0, tick - lastTick);
      lastTick = tick;
      if (drag !== null) {
        const putt: Putt = { aim: pullBack(drag.base, drag.x - drag.x0, drag.y - drag.y0), released: drag.released };
        const next = puttInput(putt, charge);
        send(next.input);
        draw(state, charge, putt.aim !== null);
        if (next.done) {
          drag = null;
          release();
        }
        return;
      }
      if (keys !== null) {
        const turn = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        keys.axis = turnAxis(keys.axis, turn * MINIGOLF_PULL.turn * elapsed);
        if (keys.space === 'up') {
          if (turn !== 0) send(puttInput({ aim: { axis: keys.axis, charge: 0 }, released: false }, charge).input);
          else {
            // Konec míření: poslední osa ještě do jednoho tiku (krátký stisk šipky se nesmí ztratit).
            const axis = keys.axis;
            keys = null;
            release();
            if (axis !== aim) session.press(0, axis);
          }
          draw(state, charge, false);
          return;
        }
        const next = puttInput(keyPutt(keys.axis, keys.space === 'held', keys.charge), charge);
        send(next.input);
        draw(state, charge, true);
        if (next.done) {
          keys.space = 'up';
          release();
          if (!keys.left && !keys.right) keys = null;
        }
        return;
      }
      draw(state, charge, false);
    };

    const local = (event: PointerEvent): { readonly x: number; readonly y: number } => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onDown = (event: PointerEvent): void => {
      if (drag !== null || keys !== null || !event.isPrimary) return;
      element.setPointerCapture(event.pointerId);
      const { x, y } = local(event);
      drag = { id: event.pointerId, x0: x, y0: y, x, y, base: minigolfCameraAxis(read().state, course), released: false };
      sync();
    };
    const onMove = (event: PointerEvent): void => {
      if (drag?.id !== event.pointerId || drag.released) return;
      const { x, y } = local(event);
      drag.x = x;
      drag.y = y;
      sync();
    };
    const onUp = (event: PointerEvent): void => {
      if (drag?.id !== event.pointerId || drag.released) return;
      drag.released = true;
      sync();
    };
    /** Zrušený dotyk (systém, ztráta zachycení): jako puštění v mrtvé zóně – bez rány, nabití pryč. */
    const onCancel = (event: PointerEvent): void => {
      if (drag?.id !== event.pointerId || drag.released) return;
      drag.x = drag.x0;
      drag.y = drag.y0;
      drag.released = true;
      sync();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const left = LEFT_KEYS.has(key);
      const right = RIGHT_KEYS.has(key);
      if (!left && !right && key !== ' ') return;
      // Vždy, i u opakování: mezerník, který hra nevzala, by HUD vzal jako pauzu (`useHudKeys`).
      event.preventDefault();
      if (event.repeat || drag !== null) return;
      keys ??= { axis: read().aim, left: false, right: false, space: 'up', charge: 0 };
      if (left || right) {
        keys.left ||= left;
        keys.right ||= right;
        keys.axis = turnAxis(keys.axis, (right ? 1 : -1) * MINIGOLF_PULL.turn);
      } else if (keys.space === 'up') keys.space = 'held';
      sync();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (keys === null) return;
      const key = event.key.toLowerCase();
      if (LEFT_KEYS.has(key)) keys.left = false;
      else if (RIGHT_KEYS.has(key)) keys.right = false;
      else if (key === ' ' && keys.space === 'held') {
        keys.space = 'released';
        keys.charge = read().charge;
      } else return;
      event.preventDefault();
      sync();
    };
    /** Ztracené okno neodpálí: rozdělané gesto se zahodí i s nabitím. */
    const onBlur = (): void => {
      drag = null;
      keys = null;
      release();
      if (read().charge > 0) session.press(BUTTON.DOWN);
      sync();
    };

    const unsubscribe = session.subscribe(sync);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    element.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    sync();
    return () => {
      unsubscribe();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      element.removeEventListener('lostpointercapture', onCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      release();
    };
  }, [session]);

  return (
    <div ref={layer} className="play-minigolf-pull" data-testid="minigolf-pull" data-pulling="false" style={{ position: 'absolute', inset: 0, touchAction: 'none', userSelect: 'none' }}>
      <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
        <line ref={band} strokeLinecap="round" style={{ stroke: 'var(--sp-color-ink)', strokeWidth: 'var(--sp-border-base)', visibility: 'hidden' }} />
      </svg>
      <div
        ref={meter}
        className="sp-hud-pill"
        role="meter"
        aria-label="Power"
        aria-valuemin={0}
        aria-valuemax={BALL.maxCharge}
        aria-valuenow={0}
        data-testid="minigolf-power"
        style={{ ...CORNER, bottom: 'calc(var(--_stack, var(--sp-space-16)) + var(--sp-size-hud-pill) + var(--sp-space-2))', width: 'calc(3 * var(--sp-size-hud-pill))', height: 'var(--sp-space-6)', padding: 'var(--sp-space-1)', visibility: 'hidden' }}
      >
        <span ref={fill} style={{ display: 'block', height: '100%', width: '0%', background: 'var(--sp-secondary)', borderRadius: 'var(--sp-radius-pill)' }} />
      </div>
      <p className="sp-hud-pill" data-testid="minigolf-score" style={{ ...CORNER, bottom: 'var(--_stack, var(--sp-space-16))' }}>
        <span ref={strokes} className="play-hud-count" data-testid="hud-counter-strokes" data-count="" />
        <span aria-hidden="true">·</span>
        <span ref={par} className="play-hud-count" data-testid="hud-counter-par" data-count="" />
      </p>
    </div>
  );
}
