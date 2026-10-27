/**
 * Ovladače Questu → vstup arkády (P65 T2). Jediný šev: totéž `press` / `hold` / `holdButtons`, které volá
 * klávesnice, takže pravidla, simulace i replay se nemění; do hashovaného stavu jdou jen tlačítka a osa.
 *
 * Mapování je klávesnice: páčka = šipky, spoušť = mezerník (hlavní akce), A/X = druhá akce (skok, úhyb, střelba
 * arény, schopnost A, úder), B/Y = střelba blasteru nebo schopnost B, grip = použití (`interact`). Kde dotyk vede
 * osu plynule (zatáčení, aréna), vede ji plynule i páčka. Rodiny ovládání jsou ty z `stage-registry` – stejné,
 * podle kterých `ArcadeStage` zapíná klávesnici.
 */

import { AXIS_MAX, BUTTON } from '@/play/arcade/contract';
import { arenaAxis } from '@/play/arcade/pieces/arena';
import { clockOf } from '@/play/arcade/pieces/merge-drop';
import type { Stage } from '@/play/compose/stage-registry';

/** Stav obou ovladačů sloučený do jedné „klávesnice“. */
export interface Pad {
  /** Páčka −1..1; `y` kladně nahoru (Gamepad API má nahoru záporně – převádí `XrInput`). */
  readonly x: number;
  readonly y: number;
  /** Spoušť kteréhokoli ovladače. */
  readonly trigger: boolean;
  /** A (pravý) nebo X (levý). */
  readonly a: boolean;
  /** B (pravý) nebo Y (levý). */
  readonly b: boolean;
  /** Grip kteréhokoli ovladače. */
  readonly grip: boolean;
}

/** Nic nedržené – i odpojený ovladač. */
export const IDLE: Pad = { x: 0, y: 0, trigger: false, a: false, b: false, grip: false };

/** Drift páčky pod touto výchylkou je klid. */
export const DEAD_ZONE = 0.15;
/** Páčka jako šipka: stisk až za polovinou výchylky, ať lehký dotyk nepřehodí pruh. */
export const ARROW = 0.5;

export type DriveMode = 'drive' | 'shoot' | 'land';

/** Co ovládání hry čte – stejné otázky, které klade `ArcadeStage` při zapínání klávesnice. */
export interface XrControl {
  readonly input: Stage['input'];
  /** Blaster (F/Enter = FIRE). */
  readonly fire: boolean;
  /** Úder v souboji (J = ATTACK). */
  readonly attack: boolean;
  /** Pravidlo `interact` (K držené = INTERACT). */
  readonly use: boolean;
  /** Počet schopností hrdiny (J/K = ACTION_A/B); se schopnostmi úder ani použití klávesy nemají. */
  readonly abilities: number;
  /** Režim zatáčení (`driveModeOf`); jen `steer`. */
  readonly drive?: DriveMode;
  /** Let střílí (`glideShoots`); jen `glide`. */
  readonly glideShoots?: boolean;
}

/** Jeden snímek vstupu: držená osa a tlačítka a stisk do nejbližšího tiku. */
export interface XrStep {
  readonly axis: number;
  readonly held: number;
  readonly press: number;
  /** Osa stisku (míření, `press(buttons, axis)`); 0 = bez ní. */
  readonly pressAxis: number;
  /** Pustit předmět, až bude připravený (slučování – klávesa i prst čekají na `clock` 0). */
  readonly drop: boolean;
}

/** Plynulá osa z páčky: drift v mrtvé zóně je 0, zbytek výchylky se roztáhne na celý rozsah. */
export function analog(value: number): number {
  const size = Math.abs(value);
  if (size <= DEAD_ZONE) return 0;
  return Math.round(Math.sign(value) * Math.min(1, (size - DEAD_ZONE) / (1 - DEAD_ZONE)) * AXIS_MAX);
}

interface Arrows {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
}

const arrows = (pad: Pad): Arrows => ({ left: pad.x < -ARROW, right: pad.x > ARROW, up: pad.y > ARROW, down: pad.y < -ARROW });

const bit = (on: boolean, value: number): number => (on ? value : 0);

/** Stav ovladačů → vstup hry; `before` je předchozí snímek (stisk je hrana), `aim` osa míření z paprsku (T3). */
export function mapPad(control: XrControl, now: Pad, before: Pad, aim: number | null = null): XrStep {
  const is = arrows(now);
  const was = arrows(before);
  const edge = (key: keyof Arrows): boolean => is[key] && !was[key];
  const pressed = (key: 'trigger' | 'a' | 'b'): boolean => now[key] && !before[key];
  const released = (key: 'trigger'): boolean => !now[key] && before[key];
  const xAxis = (Number(is.right) - Number(is.left)) * AXIS_MAX;
  const tap = BUTTON.TAP;

  let axis = 0;
  let held = 0;
  let press = 0;
  let pressAxis = 0;
  let drop = false;
  // Druhá akce rodiny na A/X; schopnost nebo úder ji přebije níž.
  let second = 0;

  switch (control.input) {
    case 'runner':
      press = bit(edge('left'), BUTTON.LEFT) | bit(edge('right'), BUTTON.RIGHT) | bit(edge('down'), BUTTON.DOWN) | bit(edge('up') || pressed('trigger'), tap);
      second = tap;
      break;
    case 'platform':
      axis = xAxis;
      press = bit(edge('up') || pressed('trigger'), tap);
      second = tap;
      break;
    case 'flap':
      press = bit(edge('up') || pressed('trigger'), tap);
      second = tap;
      break;
    case 'steer':
      axis = analog(now.x);
      held = bit(is.down, BUTTON.DOWN) | bit(control.drive === 'land' && (is.up || now.trigger), BUTTON.UP) | bit(control.drive === 'shoot' && now.trigger, BUTTON.FIRE);
      break;
    case 'arena': {
      const dx = analog(now.x);
      const dz = analog(now.y);
      axis = dx === 0 && dz === 0 ? 0 : arenaAxis(dx, dz);
      press = bit(pressed('trigger'), tap);
      second = BUTTON.FIRE;
      break;
    }
    case 'shooter-rig':
      held = bit(is.left, BUTTON.LEFT) | bit(is.right, BUTTON.RIGHT);
      if (aim !== null) {
        // Jako prst: míření drží osu, spoušť střílí tam, kam paprsek míří.
        axis = aim;
        if (pressed('trigger')) {
          press = tap;
          pressAxis = aim;
        }
      } else {
        press = bit(edge('up') || pressed('trigger'), tap);
      }
      second = tap;
      break;
    case 'throw-rig':
      // Spoušť nabíjí jako držený mezerník, puštění hodí; páčka nahoru a dolů mění úhel.
      held = bit(is.up, BUTTON.UP) | bit(is.down, BUTTON.DOWN) | bit(now.trigger, BUTTON.HOLD);
      press = bit(released('trigger'), tap);
      break;
    case 'tap':
      press = bit(edge('up') || pressed('trigger'), tap);
      second = tap;
      break;
    case 'duel':
      press = bit(edge('up') || pressed('trigger'), tap) | bit(edge('down'), BUTTON.DOWN);
      second = BUTTON.DOWN;
      break;
    case 'lanes':
      if (aim !== null && pressed('trigger')) {
        // Jako prst: ťuk na pruh pod paprskem.
        press = tap;
        pressAxis = aim;
      } else {
        press = bit(edge('left'), BUTTON.LEFT) | bit(edge('right'), BUTTON.RIGHT) | bit(pressed('trigger'), tap);
      }
      axis = aim !== null && now.trigger ? aim : 0;
      held = bit(now.trigger, BUTTON.HOLD);
      second = tap;
      break;
    case 'hop':
      press = bit(edge('up'), BUTTON.UP) | bit(edge('down'), BUTTON.DOWN) | bit(edge('left'), BUTTON.LEFT) | bit(edge('right'), BUTTON.RIGHT) | bit(pressed('trigger'), tap);
      second = tap;
      break;
    case 'merge':
      // Osa je cíl dávkovače, ne rychlost; pust čeká, až je předmět připravený.
      axis = xAxis;
      drop = pressed('trigger');
      break;
    case 'glide':
      axis = xAxis;
      held = bit(is.up, BUTTON.UP) | bit(is.down && !is.up, BUTTON.DOWN) | bit(now.a, BUTTON.HOLD) | bit(control.glideShoots === true && now.trigger, BUTTON.FIRE);
      break;
    case 'walker':
      axis = xAxis;
      held = is.up ? BUTTON.UP : bit(is.down, BUTTON.DOWN);
      break;
    case 'ball':
      // simplified: míč (nabíjení, driblink, míření šipkami po krocích) ve VR zatím jen spoušť = ťuk; doplní T3/T4.
      press = bit(pressed('trigger'), tap);
      break;
  }

  // Akce společné všem rodinám (`useFireInput`, `useActionInput`, `useAbilityInput`).
  if (control.abilities > 0) {
    press |= bit(pressed('a'), BUTTON.ACTION_A) | bit(control.abilities > 1 && pressed('b'), BUTTON.ACTION_B);
  } else {
    press |= bit(pressed('a'), control.attack ? BUTTON.ATTACK : second);
    held |= bit(control.use && now.grip, BUTTON.INTERACT);
  }
  if (control.fire && !(control.abilities > 1)) press |= bit(pressed('b'), BUTTON.FIRE);

  return { axis, held, press, pressAxis, drop };
}

/** Část relace, kterou ovladače řídí. */
export interface XrDrivenSession {
  press(buttons: number, axis?: number): void;
  hold(axis: number): void;
  holdButtons(buttons: number): void;
  state(): Int32Array;
}

/**
 * Ovladače → relace, snímek po snímku. Osu a držená tlačítka posílá jen při změně (jako klávesa), stisky hned;
 * `null` (odpojený ovladač) vše pustí. Snímková frekvence 72/90 Hz tik nemění – čas dál vlastní akumulátor relace.
 */
export function createXrDriver(session: XrDrivenSession, control: XrControl) {
  let before = IDLE;
  let axis = 0;
  let held = 0;
  let drop = false;
  return {
    frame(pad: Pad | null, aim: number | null = null): void {
      const now = pad ?? IDLE;
      const step = mapPad(control, now, before, aim);
      before = now;
      if (step.axis !== axis) {
        axis = step.axis;
        session.hold(axis);
      }
      if (step.held !== held) {
        held = step.held;
        session.holdButtons(held);
      }
      if (step.press !== 0) session.press(step.press, step.pressAxis);
      if (step.drop) drop = true;
      if (drop && clockOf(session.state()) === 0) {
        drop = false;
        session.press(BUTTON.TAP);
      }
    },
  };
}
