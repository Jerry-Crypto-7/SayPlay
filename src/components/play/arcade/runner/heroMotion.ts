/**
 * Pohyb hrdiny běžce (P32A T5, P45D T8): náklon do úhybu a póza jízdy na obalu
 * hrdiny, krok a skok podle třídy těla (`toyPoseOf` – pes cupitá, auto pruží,
 * pták mává) na vnitřní skupině pózy statického modelu. Riggovaná postava hraje
 * klipy `run/jump/hit/die`; úhyb ani jízda klip nemají, dopočítá je tenhle modul.
 *
 * Čistá funkce jako `toyPoseOf`: čte stav, stav před tikem a tik (i s podílem),
 * nikdy hodiny – týž záznam dá týž pohyb – a do relace, stavu ani hashe nic nepíše.
 */

import { BODY, HEADER, bodyBase } from '@/play/arcade/contract';
import { RIGGED_PREFIX } from '@/play/arcade/models';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { type BodyClass, type ToyPose, type ToyView, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import { BASE_ENTRIES } from '@/play/assets/entries/base';
import { type AssetEntry, heroFor } from '@/play/assets/manifest';
import { RIDE_WORDS } from '@/play/genre/runner';

import type { ArcadeSession } from '../session';
import { toyTickOf } from '../toy/applyToy';

export const HERO_MOTION = {
  /** Největší náklon do úhybu (rad, ~15°) při plné boční rychlosti změny pruhu. */
  leanMax: 0.26,
  /** Časová konstanta náklonu (tiky): za dva tiky je tělo přes třetinu, za osm skoro celé. */
  leanTicks: 2.5,
  /**
   * Předklon jízdy (rad); statický model k němu má ještě předklon běhu z `poseOf` (~15°).
   * Kamera běžce kouká shora zezadu (~22°): předklon kolem 45° vypadá z ní stejně dlouhý
   * jako stojící tělo. Vleže (~75° i s během) je z tučňáka na břiše ovál – to z kamery vidět je.
   */
  ridePitch: { lie: 1.05, board: 0.5 },
  /** Jak dlouho bliká riggovaná postava bez klipu zásahu (tiky, jako `poseOf`). */
  hitTicks: 18,
} as const;

export interface HeroMotion {
  /** Náklon kolem směru běhu (rad): + = hlavou ke scéně −x, tedy na obrazovce doprava, kam jde „RIGHT“. */
  readonly roll: number;
  /** Předklon jízdy (rad). */
  readonly pitch: number;
  /** 0..1 po zásahu hráče. */
  readonly flash: number;
  /**
   * Krok a skok podle třídy těla pro vnitřní skupinu pózy (`applyToy`). Náklon kolem
   * směru běhu patří úhybu, proto `roll` 0; jízda nemá poskok ani kroky.
   */
  readonly toy: ToyPose;
  /** Paměť náklonu: poslední celý tik a poloha x jádra (jednotky) v něm. */
  readonly tick: number;
  readonly x: number;
  readonly hitAt: number;
}

/** Pohled těla (`toyViewOf`) a jeho poloha x – z ní se počítá boční rychlost mezi dvěma výpočty. */
export interface HeroView extends ToyView {
  readonly x: number;
}

const NEVER = -1_000_000;

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * Pohyb hrdiny v tiku `tick` (smí mít podíl rozběhnutého tiku) z pohledu těla a
 * pohybu v posledním spočítaném snímku. Mezi nimi smí být víc tiků – telefon jich
 * za snímek odtiká dva, zaseknutý snímek i celou změnu pruhu (8 tiků). Náklon proto
 * jde za průměrnou boční rychlostí od minula, ne za okamžitou: změna pruhu, která
 * celá proběhla mezi dvěma snímky, se nakloní taky. `reduced` = bez hračkového pohybu.
 */
export function heroMotionOf(view: HeroView, previous: HeroMotion | null, tick: number, ride: Ride, body: BodyClass, reduced: boolean): HeroMotion {
  // Náklon a zásah jdou po celých tikách (poloha x mezi nimi stojí), krok a skok i s podílem.
  const whole = Math.floor(tick);
  // První tik a restart (tik zpět) začínají v klidu – jinak by první tik vypadal jako odraz.
  const before = previous === null || whole < previous.tick ? null : previous;
  const toy = toyPoseOf(view, body, before?.toy ?? null, tick, reduced);
  // Kolébání kroku a náklon do zatáčky by přebily náklon úhybu, který hráč čte; jízda jede bez kroků.
  const own: ToyPose = { ...toy, roll: 0, ...(ride === null ? {} : { hop: 0, stride: 0 }) };
  if (!view.alive) return { roll: 0, pitch: 0, flash: 0, toy: own, tick: whole, x: view.x, hitAt: NEVER };
  const last = before ?? { roll: 0, tick: whole, x: view.x, hitAt: NEVER };
  const elapsed = whole - last.tick;
  const vx = elapsed > 0 ? (view.x - last.x) / elapsed : view.vx;
  // Boční rychlost je při změně pruhu `laneSpeed`, jinak 0; náklon se k ní blíží exponenciálně.
  const target = HERO_MOTION.leanMax * clamp(vx / RUNNER.laneSpeed, -1, 1);
  const roll = target + (last.roll - target) * Math.exp(-elapsed / HERO_MOTION.leanTicks);
  const hitAt = view.hit ? whole : last.hitAt;
  const sinceHit = tick - hitAt;
  return {
    roll,
    pitch: ride === null ? 0 : HERO_MOTION.ridePitch[ride],
    flash: sinceHit < HERO_MOTION.hitTicks ? 1 - sinceHit / HERO_MOTION.hitTicks : 0,
    toy: own,
    tick: whole,
    x: view.x,
    hitAt,
  };
}

export interface HeroMotionDriver {
  /** Pohyb hráče pro aktuální tik relace i s podílem; přepočte se, jen když se posunul. */
  sample(reduced?: boolean): HeroMotion;
}

/** Co pohyb z relace smí: jen číst stav. Stisknout, posunout hodiny ani restartovat nemůže. */
export type HeroMotionSource = Pick<ArcadeSession, 'state' | 'prev' | 'alpha' | 'endedFor'>;

/** Pohyb hrdiny třídy těla `body` nad relací; `sample(reduced)` – `reduced` = `!toyMotionOn()`. */
export function createHeroMotion(source: HeroMotionSource, ride: Ride, body: BodyClass): HeroMotionDriver {
  let motion: HeroMotion | null = null;
  return {
    sample: (reduced = false) => {
      const state = source.state();
      const tick = toyTickOf(source);
      if (motion === null || motion.toy.at !== tick) {
        const player = state[HEADER.player] as number;
        const view = { ...toyViewOf(state, source.prev(), player), x: state[bodyBase(player) + BODY.x] as number };
        motion = heroMotionOf(view, motion, tick, ride, body, reduced);
      }
      return motion;
    },
  };
}

/** Položka manifestu hrdiny: podle id modelu (tučňák, riggovaná postava), jinak podle jeho slov („gen3d-bald-eagle“ → pták). */
function entryOf(hero: string): AssetEntry | null {
  const id = hero.startsWith(RIGGED_PREFIX) ? hero.slice(RIGGED_PREFIX.length) : hero;
  // Číslice a spojovníky id by slova slepily („d-bald-eagle“) – `heroFor` čte slova, ne id.
  return BASE_ENTRIES.find((entry) => entry.id === id) ?? heroFor(hero.replace(/[^a-z]+/gi, ' '), 'runner');
}

/** Póza jízdy: `lie` = na břiše, `board` = předklon jako na prkně či lyžích; `null` = běží. */
export type Ride = 'lie' | 'board' | null;

/**
 * Póza jízdy – tělo skloněné dopředu, bez poskoku kroků. Pták jede na břiše
 * (tučňák klouže), hrdina, který jede (`rides` = `theme.motion` z věty přes `sceneLook`,
 * T5-R1), nebo model jízdy (`cc0-sled`) v předklonu. `hero` = id modelu z `Cast`.
 */
export function rideOf(hero: string, rides = false): Ride {
  if (entryOf(hero)?.class === 'bird') return 'lie';
  return rides || RIDE_WORDS.test(hero.toLowerCase()) ? 'board' : null;
}

/**
 * Riggovaná postava, které manifest klip zásahu nedal (`hit: 'procedural'`),
 * po zásahu bliká jako statický model – `RiggedModel` by jinak hrál klid.
 */
export function blinksOnHit(hero: string): boolean {
  return hero.startsWith(RIGGED_PREFIX) && entryOf(hero)?.clips.hit === 'procedural';
}
