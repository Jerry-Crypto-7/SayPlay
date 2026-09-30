/**
 * Pohyb hrdiny běžce (P32A T5): náklon do úhybu, zmáčknutí při odrazu a póza
 * jízdy. Přičítá se k tomu, čím hrdinu hýbe sdílený `World`: statický model
 * dostává pózu `poseOf` (`motion.ts` – poskok, předklon, natažení ve vzduchu,
 * zmáčknutí po dopadu), riggovaná postava klipy `run/jump/hit/die`. Úhyb ani
 * jízda klip nemají, dopočítá je tenhle modul.
 *
 * Čistá funkce jako `poseOf`: čte stav, stav před tikem a tik, nikdy hodiny –
 * týž záznam dá týž pohyb – a do relace, stavu ani hashe nic nepíše.
 */

import { BODY, HEADER, bodyBase } from '@/play/arcade/contract';
import { RIGGED_PREFIX } from '@/play/arcade/models';
import { type MotionView, viewOf } from '@/play/arcade/motion';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { BASE_ENTRIES } from '@/play/assets/entries/base';
import { type AssetEntry, heroFor } from '@/play/assets/manifest';

import type { ArcadeSession } from '../session';

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
  /** Zmáčknutí v tiku odrazu (podíl výšky); za `takeoffTicks` povolí a natažení převezme skok. */
  takeoffSquash: 0.4,
  takeoffTicks: 6,
  /** Jak dlouho bliká riggovaná postava bez klipu zásahu (tiky, jako `poseOf`). */
  hitTicks: 18,
} as const;

export interface HeroMotion {
  /** Náklon kolem směru běhu (rad): + = hlavou ke scéně −x, tedy na obrazovce doprava, kam jde „RIGHT“. */
  readonly roll: number;
  /** Předklon jízdy (rad). */
  readonly pitch: number;
  /** > 0 zmáčknutí po odrazu (podíl výšky). */
  readonly squash: number;
  /** 0..1 po zásahu hráče. */
  readonly flash: number;
  /** Paměť pro další tik. */
  readonly tick: number;
  /** Poloha x jádra (jednotky) v tiku `tick`. */
  readonly x: number;
  readonly grounded: boolean;
  readonly takeoffAt: number;
  readonly hitAt: number;
}

/** Pohled těla (`viewOf`) a jeho poloha x – z ní se počítá boční rychlost mezi dvěma výpočty. */
export interface HeroView extends MotionView {
  readonly x: number;
}

const NEVER = -1_000_000;

const restAt = (tick: number, x: number, grounded: boolean): HeroMotion => ({ roll: 0, pitch: 0, squash: 0, flash: 0, tick, x, grounded, takeoffAt: NEVER, hitAt: NEVER });

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * Pohyb hrdiny v tiku `tick` z pohledu těla a pohybu v posledním spočítaném tiku.
 * Mezi nimi smí být víc tiků – telefon jich za snímek odtiká dva, zaseknutý snímek
 * i celou změnu pruhu (8 tiků). Náklon proto jde za průměrnou boční rychlostí od
 * minula, ne za okamžitou: změna pruhu, která celá proběhla mezi dvěma snímky, se
 * nakloní taky.
 */
export function heroMotionOf(view: HeroView, previous: HeroMotion | null, tick: number, ride: Ride): HeroMotion {
  if (!view.alive) return restAt(tick, view.x, true);
  // První tik a restart (tik zpět) začínají v klidu – jinak by první tik vypadal jako odraz.
  const before = previous === null || tick < previous.tick ? restAt(tick, view.x, view.grounded) : previous;
  const elapsed = tick - before.tick;
  const vx = elapsed > 0 ? (view.x - before.x) / elapsed : view.vx;
  // Boční rychlost je při změně pruhu `laneSpeed`, jinak 0; náklon se k ní blíží exponenciálně.
  const target = HERO_MOTION.leanMax * clamp(vx / RUNNER.laneSpeed, -1, 1);
  const roll = target + (before.roll - target) * Math.exp(-elapsed / HERO_MOTION.leanTicks);
  // Odraz = ze země nahoru; pád z hrany odrazem není.
  const takeoffAt = before.grounded && !view.grounded && view.vy > 0 ? tick : before.takeoffAt;
  const sinceTakeoff = tick - takeoffAt;
  const squash = !view.grounded && sinceTakeoff < HERO_MOTION.takeoffTicks ? HERO_MOTION.takeoffSquash * (1 - sinceTakeoff / HERO_MOTION.takeoffTicks) : 0;
  const hitAt = view.hit ? tick : before.hitAt;
  const sinceHit = tick - hitAt;
  return {
    roll,
    pitch: ride === null ? 0 : HERO_MOTION.ridePitch[ride],
    squash,
    flash: sinceHit < HERO_MOTION.hitTicks ? 1 - sinceHit / HERO_MOTION.hitTicks : 0,
    tick,
    x: view.x,
    grounded: view.grounded,
    takeoffAt,
    hitAt,
  };
}

export interface HeroMotionDriver {
  /** Pohyb hráče pro aktuální tik relace; přepočte se, jen když přibyl tik. */
  sample(): HeroMotion;
}

/** Co pohyb z relace smí: jen číst stav. Stisknout, posunout hodiny ani restartovat nemůže. */
export type HeroMotionSource = Pick<ArcadeSession, 'state' | 'prev'>;

export function createHeroMotion(source: HeroMotionSource, ride: Ride): HeroMotionDriver {
  let motion: HeroMotion | null = null;
  return {
    sample: () => {
      const state = source.state();
      const tick = state[HEADER.tick] as number;
      if (motion === null || motion.tick !== tick) {
        const player = state[HEADER.player] as number;
        const view = { ...viewOf(state, source.prev(), player), x: state[bodyBase(player) + BODY.x] as number };
        motion = heroMotionOf(view, motion, tick, ride);
      }
      return motion;
    },
  };
}

/** Slova jízdy: klouže, lyžuje, surfuje, jede na prkně, bruslích nebo saních (tvary jako `cues` žánru běžce). */
const RIDE_WORDS =
  /\b(?:slid(?:e|es|ing)|ski(?:s|ed|ing|er|ers)?|surf(?:s|ed|ing|er|ers|board|boards)?|snowboard(?:s|ed|ing|er|ers)?|skat(?:e|es|ed|ing|er|ers)|skateboard(?:s|ing|er|ers)?|sled(?:s|ge|ges|ding)?|toboggan(?:s|ed|ing)?)\b/;

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
 * (tučňák klouže), hrdina či věta, která klouže, lyžuje nebo surfuje, v předklonu.
 * `hero` = id modelu z `Cast`; věta na plátno nedojde (spec ji nenese), proto je nepovinná.
 */
export function rideOf(hero: string, sentence = ''): Ride {
  if (entryOf(hero)?.class === 'bird') return 'lie';
  return RIDE_WORDS.test(`${hero} ${sentence}`.toLowerCase()) ? 'board' : null;
}

/**
 * Riggovaná postava, které manifest klip zásahu nedal (`hit: 'procedural'`),
 * po zásahu bliká jako statický model – `RiggedModel` by jinak hrál klid.
 */
export function blinksOnHit(hero: string): boolean {
  return hero.startsWith(RIGGED_PREFIX) && entryOf(hero)?.clips.hit === 'procedural';
}
