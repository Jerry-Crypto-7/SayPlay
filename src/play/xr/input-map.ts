/**
 * Ovladače Questu → vstup arkády (P65 T2). Jediný šev: totéž `press` / `hold` / `holdButtons`, které volá
 * klávesnice, takže pravidla, simulace i replay se nemění; do hashovaného stavu jdou jen tlačítka a osa.
 *
 * Mapování je klávesnice: páčka = šipky, spoušť = mezerník (hlavní akce), A/X = druhá akce (skok, úhyb, střelba
 * arény, schopnost A, úder), B/Y = střelba blasteru nebo schopnost B, grip = použití (`interact`). Kde dotyk vede
 * osu plynule (zatáčení, aréna), vede ji plynule i páčka. Rodiny ovládání jsou ty z `stage-registry` – stejné,
 * podle kterých `ArcadeStage` zapíná klávesnici.
 */

import { AXIS_MAX, BODY, BUTTON, HEADER, bodyBase } from '@/play/arcade/contract';
import { arenaAxis } from '@/play/arcade/pieces/arena';
import { axisOfLane, laneOfX } from '@/play/arcade/pieces/lanes';
import { clockOf } from '@/play/arcade/pieces/merge-drop';
import { SHOOTER, aimAt } from '@/play/arcade/pieces/shooter';
import { THROW } from '@/play/arcade/pieces/throw';
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
  /** Grip pravého ovladače; levý nese desku dioramy (T4). */
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
  /** Pruhy, ve kterých ruka seká (`slice_cut`) nebo bouchá (`whack_hit`) máchnutím (T3). */
  readonly swing?: 'slice' | 'whack';
  /** Pruh drží poloha pravé ruky, jako tažený prst (chytání `catch_fall`, P67 T6). */
  readonly handLane?: boolean;
}

/**
 * Pohyb pravého ovladače v prostoru hry (T3), přepisovaný každý snímek. `aim` = osa míření z paprsku,
 * `velocity` = rychlost ruky v m/s skutečného prostoru, otočená do os hry (+y nahoru, +z dopředu),
 * `laneAxis` = osa pruhu pod rukou, `handX` = poloha pravé ruky v ose x jádra (jednotky; chytání, P67 T6). Nic z toho
 * nejde do hashovaného stavu – jen tlačítka a osa, které z něj vzejdou.
 */
export interface XrMotion {
  aim: number | null;
  velocity: { readonly x: number; readonly y: number; readonly z: number } | null;
  laneAxis: number | null;
  handX?: number | null;
}

/**
 * Svět krájení a bouchání ve VR (T3): pět pruhů v dosahu ruky. Měřítko 1:10 dá pruhy 0,2 m od sebe, obal stojí
 * ve výšce pasu a řada děr (`WHACK.holeZ`) vyjde ~0,5 m před hráče. Obal je otočený o půl kruhu jako diorama.
 */
export const REACH = { scale: 1 / 10, at: [0, 0.85, -0.26] } as const;

/** Prahy pohybu ruky (T3) v m/s skutečného prostoru – měřítko světa je nemění. Doladí T8 v brýlích. */
export const SWING = {
  /** Hod: pod `throwMin` žádný hod (puštění spouště bez máchnutí), od `throwMax` plná síla. */
  throwMin: 1,
  throwMax: 6,
  /** Švih krájení (kterýkoli směr) a úder do díry (dolů). */
  slice: 1.5,
  whack: 1.2,
} as const;

/**
 * Hod z rychlosti ruky v rovině hry (nahoru `vy`, dopředu `vz`, m/s) → úhel a nabití, které jinak dá tah
 * a držení prstu: síla roste s rychlostí od 1 tiku nabití po plné, nad `throwMax` se ořízne; úhel je směr ruky
 * v mezích hodu (5°–85°). `null` = žádný hod (pomalá ruka, nebo ruka nejde dopředu).
 */
export function throwOf(vy: number, vz: number): { readonly aim: number; readonly charge: number } | null {
  const speed = Math.hypot(vy, vz);
  if (vz <= 0 || speed < SWING.throwMin) return null;
  const power = (Math.min(speed, SWING.throwMax) - SWING.throwMin) / (SWING.throwMax - SWING.throwMin);
  const angle = (Math.atan2(vy, vz) * 180) / Math.PI;
  const clipped = Math.min(THROW.baseDeg + THROW.spanDeg, Math.max(THROW.baseDeg - THROW.spanDeg, angle));
  const aim = Math.round(((clipped - THROW.baseDeg) * AXIS_MAX) / THROW.spanDeg);
  // Osa 0 = „beze změny“, proto 45° je 1.
  return { aim: aim === 0 ? 1 : aim, charge: 1 + Math.round(power * (THROW.maxCharge - 1)) };
}

/**
 * Ruka nad pruhem → osa, kterou dá prst na témž pruhu (`lanes-input.ts`): `x` je poloha ruky v ose x jádra
 * (jednotky). Jediný převod polohy ruky na vstup – krájení, bouchání i chytání jdou tudy.
 */
export const laneAxisOfX = (x: number): number => axisOfLane(laneOfX(x));

/** Švih nad prahem sekne jednou; další až po zpomalení ruky pod polovinu prahu (chvění na vrcholu nesekne dvakrát). */
export function createSwing(threshold: number): (speed: number) => boolean {
  let armed = true;
  return (speed) => {
    if (armed && speed >= threshold) {
      armed = false;
      return true;
    }
    if (speed < threshold / 2) armed = true;
    return false;
  };
}

/** Mávnutí páčkou (P67 T4, listování feedu): výchylka svisle aspoň tolik. */
export const FLICK = 0.7;

/**
 * Mávnutí páčkou nahoru (`1`) nebo dolů (`-1`), `y` kladně nahoru: jednou za výchylku přes `FLICK`, převážně svisle;
 * další až po návratu páčky pod `ARROW`. Páčka držená nahoře tak nelistuje dokola.
 */
export function createFlick(): (x: number, y: number) => -1 | 0 | 1 {
  let armed = true;
  return (x, y) => {
    if (Math.abs(y) < ARROW) {
      armed = true;
      return 0;
    }
    if (!armed || Math.abs(y) < FLICK || Math.abs(y) <= Math.abs(x)) return 0;
    armed = false;
    return y > 0 ? 1 : -1;
  };
}

/**
 * Spoušť jedné ruky pro hru (P65 T5): spoušť je zároveň „klik“ paprsku na panelu HUD. Stisk, který začal
 * s paprskem na tlačítku panelu, patří panelu až do puštění, i když paprsek mezitím z tlačítka sjede; stisk, který
 * začal jinde, patří hře, i když paprsek najede na panel. Vrací, jestli je spoušť ruky `hand` stisknutá pro hru.
 */
export function createTriggerOwner(): (hand: string, down: boolean, onPanel: boolean) => boolean {
  const owner = new Map<string, 'game' | 'panel'>();
  return (hand, down, onPanel) => {
    if (!down) {
      owner.delete(hand);
      return false;
    }
    if (!owner.has(hand)) owner.set(hand, onPanel ? 'panel' : 'game');
    return owner.get(hand) === 'game';
  };
}

/**
 * Bod hry pod paprskem (jednotky jádra, osy jádra) → osa míření, kterou dá prst na témž místě: střílečka míří
 * z hlavně (`aimAt`, jako `ShooterRig`), pruhy berou pruh, ve kterém bod leží. `null` = paprsek nemíří nikam.
 */
export function aimOfPoint(input: Stage['input'], x: number, z: number, state: Int32Array): number | null {
  const player = bodyBase(state[HEADER.player] as number);
  if (input === 'shooter-rig') {
    const muzzleZ = (state[player + BODY.z] as number) + SHOOTER.playerD / 2;
    return z > muzzleZ ? aimAt(x - (state[player + BODY.x] as number), z - muzzleZ) : null;
  }
  if (input === 'lanes') return laneAxisOfX(x);
  return null;
}

/** Nabití hodu v těle hráče (`aux1`; v tiku puštění záporné). */
const chargeOf = (state: Int32Array): number => Math.max(0, state[bodyBase(state[HEADER.player] as number) + BODY.aux1] as number);

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
  // Hod máchnutím: nejsilnější švih, dokud spoušť drží míček, a hod, který po puštění čeká na nabití.
  let peak: ReturnType<typeof throwOf> = null;
  let pending: ReturnType<typeof throwOf> = null;
  const swung = control.swing === undefined ? null : createSwing(control.swing === 'whack' ? SWING.whack : SWING.slice);
  return {
    frame(pad: Pad | null, motion: XrMotion | null = null): void {
      const now = pad ?? IDLE;
      const step = mapPad(control, now, before, motion?.aim ?? null);
      let stepHeld = step.held;
      let { press, pressAxis } = step;
      const velocity = motion?.velocity ?? null;
      if (control.input === 'throw-rig' && velocity !== null) {
        // Spoušť drží míček a nabíjí jen do síly nejrychlejšího švihu; puštění hodí jeho směrem, až je nabito –
        // tutéž cestou jako prst (`HOLD` nabíjí, `TAP` s osou úhlu hodí).
        stepHeld &= ~BUTTON.HOLD;
        press &= ~BUTTON.TAP;
        if (now.trigger) {
          const sample = throwOf(velocity.y, velocity.z);
          if (sample !== null && (peak === null || sample.charge >= peak.charge)) peak = sample;
        } else if (before.trigger) {
          pending = peak;
          peak = null;
        }
        const target = now.trigger ? peak : pending;
        if (target !== null && chargeOf(session.state()) < target.charge) stepHeld |= BUTTON.HOLD;
        else if (!now.trigger && pending !== null) {
          press |= BUTTON.TAP;
          pressAxis = pending.aim;
          pending = null;
        }
      }
      if (swung !== null && velocity !== null && motion?.laneAxis != null) {
        const speed = control.swing === 'whack' ? -velocity.y : Math.hypot(velocity.x, velocity.y, velocity.z);
        if (swung(speed)) {
          press |= BUTTON.TAP;
          pressAxis = motion.laneAxis;
        }
      }
      before = now;
      // Chytání (P67 T6): pruh drží ruka nad ním jako tažený prst; páčka do strany ho na tik posune, ruka ho vrátí.
      const hand = control.handLane === true ? (motion?.handX ?? null) : null;
      const stepAxis = hand === null ? step.axis : laneAxisOfX(hand);
      if (stepAxis !== axis) {
        axis = stepAxis;
        session.hold(axis);
      }
      if (stepHeld !== held) {
        held = stepHeld;
        session.holdButtons(held);
      }
      if (press !== 0) session.press(press, pressAxis);
      if (step.drop) drop = true;
      // Připravený předmět má hodiny ≤ 0 (záporné = tiky čekání, `mergeDropRule`), jako u klávesy (`dropNow`).
      if (drop && clockOf(session.state()) <= 0) {
        drop = false;
        session.press(BUTTON.TAP);
      }
    },
  };
}
