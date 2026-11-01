/**
 * Minigolf (P68 T6): celočíselné kutálení míčku v jádře – směr z osy, síla z nabití, odraz od osově zarovnaných
 * překážek, přeskok mantinelu, útlum a zastavení. Čisté funkce bez stavu: totéž počítá ovládání (`minigolf.ts`),
 * robot (T7, `minigolfRest` / `minigolfChargeFor`) i scéna (T8, `minigolfAim`).
 *
 * Proč ne koule Rapieru: spike T6 (50 ran, 3 síly, README P68V) – koule s celočíselným útlumem rychlosti se
 * roztáčí (útlum bere jen lineární rychlost, rotace ji třením vrací), takže při síle 35 a 60 se 20 z 33 ran
 * nezastavilo ani za 600 tiků. Stupeň 1 žebříku zjednodušení: kutálení v jádře se stejným ovládáním.
 *
 * Všechno jsou celá čísla; jediné dělení je dělení dvou celých čísel (IEEE ho zaokrouhlí všude stejně) a hned
 * `Math.trunc`. Žádná trigonometrie: směr je bod na obvodu čtverce (`minigolfAim`), ne úhel.
 */

import { AXIS_MAX } from '../contract';
import { BALL, ballSpeed } from './ball';

export const MINIGOLF = {
  /** Dlaždice dráhy = šířka chodby mezi mantinely. */
  tile: 4000,
  /** Tloušťka a výška mantinelu. */
  rail: 300,
  railHeight: 300,
  /** Průměr míčku (míč P41). */
  ball: BALL.size,
  /** Průměr jamky; míček je v ní, když jeho střed leží v kruhu jamky. */
  holeSize: 1000,
  /** Nad tímhle (jednotek za tik) míček jamku přeletí. */
  holeSpeed: 60,
  /** Útlum: rychlost klesne o tolik za tik; rychlost nejvýš tahle = stojí. */
  decel: 2,
  /** Nejdelší krok kolizního podkroku – míček neprojde mantinelem ani při plné síle. */
  substep: 100,
  /** Odraz v promile: mantinel, odrazník, pohyblivá překážka. */
  railBounce: 700,
  bumperBounce: 800,
  /** Kolmá rychlost proti mantinelu nad tímhle = míček ho přeskočí (mimo dráhu). Plná síla kolmo je 240. */
  hopSpeed: 180,
  /** Rána plnou silou na volné ploše stojí do tolika tiků (AC T6; plná síla stojí za 120). */
  stopTicks: 180,
  /** Limit ran = par + tolik. */
  extraStrokes: 3,
  /** Skóre výhry = tolik × (limit ran + 1 − rány). */
  scorePerStroke: 100,
  /** Pohyblivá překážka: rozsah pohybu napříč chodbou a rychlosti (rozsah / rychlost = perioda v tikách). */
  moverAmplitude: 2000,
  moverSpeeds: [25, 40, 50],
  /** Volný pruh trasy robota navíc k poloměru míčku. */
  clearance: 150,
} as const;

/** Dolní celá odmocnina celého čísla: `Math.sqrt` jen jako odhad, výsledek opravený celými čísly. */
export function isqrt(n: number): number {
  let root = Math.floor(Math.sqrt(n));
  while (root * root > n) root -= 1;
  while ((root + 1) * (root + 1) <= n) root += 1;
  return root;
}

/** Polovina strany čtverce směrů: obvod 8 × 250 = 2000 = rozsah osy. */
const SIDE = AXIS_MAX / 4;

/**
 * Osa → směr míření `[dx, dz]` (nenormalizovaný bod na obvodu čtverce o polovině strany 250): 0 = +z (od odpaliště
 * dál), kladná osa doprava k +x, ±500 = ±x, ±1000 = −z. Spojitá a prostá: 2000 směrů dokola, krok 0,11–0,23°.
 */
export function minigolfAim(axis: number): readonly [number, number] {
  const a = Math.min(AXIS_MAX, Math.abs(Math.trunc(axis)));
  const [x, z] = a <= SIDE ? [a, SIDE] : a <= 3 * SIDE ? [SIDE, 2 * SIDE - a] : [AXIS_MAX - a, -SIDE];
  return [axis < 0 ? -x : x, z];
}

/** Opak `minigolfAim`: osa, která míří nejblíž směru `(dx, dz)`; nulový vektor = 0 (+z). Pro robota a dotyk. */
export function minigolfAxisToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return 0;
  const ax = Math.abs(dx);
  const a = Math.abs(dz) >= ax ? (dz > 0 ? Math.round((ax * SIDE) / dz) : AXIS_MAX - Math.round((ax * SIDE) / -dz)) : 2 * SIDE - Math.round((dz * SIDE) / ax);
  return dx < 0 ? -a : a;
}

/** Rychlost rány z nabití: `ballSpeed` bez jeho minima, 4–240 jednotek za tik (nabití 1–60 tiků `HOLD`). */
export const minigolfSpeed = (charge: number): number => ballSpeed(charge) - BALL.minSpeed;

/** Rychlost míčku po ráně osou `axis` s nabitím `charge`. */
export function minigolfShot(axis: number, charge: number): readonly [number, number] {
  const speed = minigolfSpeed(charge);
  const [dx, dz] = minigolfAim(axis);
  const length = isqrt(dx * dx + dz * dz);
  return [Math.trunc((speed * dx) / length), Math.trunc((speed * dz) / length)];
}

/** Útlum jednoho tiku: velikost rychlosti o `decel` níž při stejném směru; nejvýš `decel` = stojí. */
export function minigolfDamp(vx: number, vz: number): readonly [number, number] {
  const speed = isqrt(vx * vx + vz * vz);
  if (speed <= MINIGOLF.decel) return [0, 0];
  return [Math.trunc((vx * (speed - MINIGOLF.decel)) / speed), Math.trunc((vz * (speed - MINIGOLF.decel)) / speed)];
}

/**
 * Překážka kutálení: osově zarovnaný kvádr (střed `x/z`, rozměry `w/d`), jeho rychlost v tomto tiku (pohyblivá;
 * jádro ji posune až po ovládání, takže se srážka počítá s polohou na konci tiku), odraz v promile a jestli ho rychlý
 * míček přeskočí (mantinel).
 */
export interface MinigolfCollider {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly vx: number;
  readonly vz: number;
  readonly bounce: number;
  readonly hop: boolean;
}

export interface MinigolfBall {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

/** Jeden díl pohybu `v` rozděleného na `n` celých kroků (součet dílů = `v`). */
const part = (v: number, k: number, n: number): number => Math.trunc((v * (k + 1)) / n) - Math.trunc((v * k) / n);

/** Míček se dotkne hranou: střed na `center ± ceil((size + ball) / 2)`, kde už nejde o průnik. */
const touch = (center: number, size: number, side: number): number => center + side * Math.ceil((size + MINIGOLF.ball) / 2);

/**
 * Jeden tik kutálení: pohyb rychlostí po podkrocích (nejvýš `substep`), po každém srážka s překážkami v pořadí
 * seznamu – vytlačení po ose menšího průniku a odraz kolmé složky (relativní k pohybu překážky), mantinel s kolmou
 * rychlostí nad `hopSpeed` míček přeskočí (střed hned za ním, `hopped`). Pak útlum.
 */
export function minigolfRoll(ball: MinigolfBall, colliders: readonly MinigolfCollider[]): MinigolfBall & { readonly hopped: boolean } {
  let { x, z, vx, vz } = ball;
  let hopped = false;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vz)) / MINIGOLF.substep));
  for (let k = 0; k < n; k += 1) {
    x += part(vx, k, n);
    z += part(vz, k, n);
    for (const c of colliders) {
      const cx = c.x + c.vx;
      const cz = c.z + c.vz;
      const gapX = c.w + MINIGOLF.ball - Math.abs(2 * (x - cx));
      const gapZ = c.d + MINIGOLF.ball - Math.abs(2 * (z - cz));
      if (gapX <= 0 || gapZ <= 0) continue;
      const alongX = gapX < gapZ || (gapX === gapZ && Math.abs(vx) >= Math.abs(vz));
      const [p, center, size, v, cv] = alongX ? [x, cx, c.w, vx, c.vx] : [z, cz, c.d, vz, c.vz];
      const side = p > center ? 1 : p < center ? -1 : v > 0 ? -1 : 1;
      const rel = v - cv;
      let np = touch(center, size, side);
      let nv = v;
      if (side * rel < 0) {
        if (c.hop && -side * rel > MINIGOLF.hopSpeed) {
          np = touch(center, size, -side) - side;
          hopped = true;
        } else nv = cv + Math.trunc((-rel * c.bounce) / 1000);
      }
      if (alongX) {
        x = np;
        vx = nv;
      } else {
        z = np;
        vz = nv;
      }
    }
  }
  const [dvx, dvz] = minigolfDamp(vx, vz);
  return { x, z, vx: dvx, vz: dvz, hopped };
}

/**
 * Uzavřený vzorec: dráha rány s nabitím `charge` přímo po ose (rychlost s = 4·charge, kroky s, s − 2, …, 2):
 * s(s + 2) / 4 = 4·charge² + 2·charge. Šikmá rána ujede o pár jednotek méně (useknutí složek) – přesně `minigolfRest`.
 */
export const minigolfDistance = (charge: number): number => {
  const speed = minigolfSpeed(charge);
  return (speed * (speed + MINIGOLF.decel)) / (2 * MINIGOLF.decel);
};

/** Kam a za kolik tiků se míček po ráně dokutálí na volné ploše (posun od místa rány) – přesně jako ve hře. */
export function minigolfRest(axis: number, charge: number): { readonly dx: number; readonly dz: number; readonly ticks: number } {
  const [svx, svz] = minigolfShot(axis, charge);
  let ball: MinigolfBall = { x: 0, z: 0, vx: svx, vz: svz };
  let ticks = 0;
  while (ball.vx !== 0 || ball.vz !== 0) {
    ball = minigolfRoll(ball, []);
    ticks += 1;
  }
  return { dx: ball.x, dz: ball.z, ticks };
}

/** Nejmenší nabití, se kterým rána osou `axis` ujede aspoň `distance` (jinak plné). Robot jím míří na bod trasy. */
export function minigolfChargeFor(axis: number, distance: number): number {
  for (let charge = 1; charge < BALL.maxCharge; charge += 1) {
    const rest = minigolfRest(axis, charge);
    if (rest.dx * rest.dx + rest.dz * rest.dz >= distance * distance) return charge;
  }
  return BALL.maxCharge;
}
