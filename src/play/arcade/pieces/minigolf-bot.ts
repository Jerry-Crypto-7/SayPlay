/**
 * Robot minigolfu (P68 T7). Hraje jako hráč: drží `HOLD` s osou tolik tiků, kolik chce nabití, a pustí `TAP` s toutéž
 * osou – rána jen ze stojícího míčku, nic mimo vstup.
 *
 * - **Kam:** po trase z úrovně (`layout.route`, rohy dráhy a nakonec jamka). Z místa, kde míček stojí, zkusí body trasy
 *   od jamky zpět a vezme první, kam rána opravdu dojede: kutálení `minigolfRoll` po mantinelech a odraznících (čistá
 *   funkce jádra, takže předpověď = hra) – u jamky míček v jamce, u rohu zastavení do `near` bez jediného nárazu.
 * - **Jak silně a kam přesně:** nabití z uzavřeného vzorce `minigolfDistance(c) = 4c² + 2c` (vzdálenost → nejmenší
 *   `c`), opravené přesným `minigolfRest` o useknuté složky šikmé rány. Celočíselný útlum ubírá menší složce rychlosti
 *   relativně víc, takže šikmá rána se stáčí k ose; robot proto osu opraví o úhel, o který se klid rány minul s cílem
 *   (`minigolfAimAt`, pár kroků).
 * - **Kdy:** s pohyblivou překážkou čeká na první tik puštění (do dvou period kyvadla), kdy rána i stojící míček během
 *   nabíjení překážku minou – ověřené kutálením s překážkou v poloze `minigolfMoverAt` (ukotvené na stav, který robot
 *   vidí) tik po tiku. Bez okna hraje hned (nikdy nečeká donekonečna).
 * - Vidí stav o `reaction` tiků starší: nabití = nabití ve stavu + `HOLD` z `recent`, `TAP` v `recent` = rána letí.
 *
 * **Slabý robot** = týž robot s pevnou chybou osy (`aimError`, jednotky osy) a síly (`powerPct`, % nabití) – míří
 * vedle a krátce, takže vyčerpá rány (`MINIGOLF_BOT.weak`). Robot světa je má 0 a 100.
 *
 * Jen celá čísla a `Math.sqrt` (IEEE přesně zaokrouhlená, opravená celými čísly): Node i prohlížeč volí totéž.
 */

import { z } from 'zod';

import { AXIS_MAX, type ArcadeInput, type ArcadeState, BODY, BUTTON, type BotPiece, HEADER, NO_INPUT, bodyBase } from '../contract';
import { BALL } from './ball';
import { type MinigolfLayout, minigolfLayout, minigolfMoverAt } from './minigolf-hole';
import { MINIGOLF, type MinigolfCollider, isqrt, minigolfAxisToward, minigolfDamp, minigolfDistance, minigolfRest, minigolfRoll, minigolfShot } from './minigolf-roll';

export const MINIGOLF_BOT = {
  /** Reakce robota (tiky): vidí stav o tolik starší, jako každý robot knihovny. */
  reaction: 8,
  /** Roh trasy je splněný, když míček zastaví nejvýš tak daleko od něj (krok nabití u plné rány je 486 j). */
  near: 700,
  /** Hrubé síto okna pohyblivé překážky: odstup navíc k jejímu a míčkovu poloměru; okno pak ověří kutálení. */
  moverMargin: 0,
  /** Nejdelší předpověď rány (tiky); plná rána na volné ploše stojí za 120. */
  horizon: 400,
  /** Kroky opravy osy na stáčení šikmé rány. */
  aimSteps: 6,
  /** Slabý robot: osa o tolik vedle a nabití na tolik procent. Prohraje vyčerpáním ran (test na 30 jamkách). */
  weak: { aimError: 120, powerPct: 60 },
} as const;

const botParams = z
  .object({
    layout: minigolfLayout,
    /** Pevná chyba osy (jednotky osy); 0 = robot světa. */
    aimError: z.int().min(-500).max(500).default(0),
    /** Nabití v procentech plánu; 100 = robot světa. */
    powerPct: z.int().min(10).max(200).default(100),
  })
  .strict();
export type MinigolfBotParams = z.infer<typeof botParams>;

type Point = readonly [number, number];

/** Předpověď jedné rány. */
export interface MinigolfShotPlan {
  readonly axis: number;
  readonly charge: number;
  /** Poloha míčku na konci každého tiku letu (první = tik puštění). */
  readonly path: readonly Point[];
  /** Míček skončí v jamce (střed v kruhu jamky a rychlost do `holeSpeed`). */
  readonly holed: boolean;
  /** Míček přeskočí mantinel (mimo dráhu). */
  readonly hopped: boolean;
  /** Míček cestou narazí (rychlost jiná než po samotném útlumu). */
  readonly bumped: boolean;
  readonly rest: Point;
}

const sq = (value: number): number => value * value;
const gap = (a: Point, b: Point): number => isqrt(sq(a[0] - b[0]) + sq(a[1] - b[1]));
/** Osa do rozsahu −1000..999 (±1000 je týž směr −z). */
const wrapAxis = (axis: number): number => ((((axis + AXIS_MAX) % (2 * AXIS_MAX)) + 2 * AXIS_MAX) % (2 * AXIS_MAX)) - AXIS_MAX;

/** Mantinely a odrazníky ze stavu, v pořadí jádra (`collidersOf` v `minigolf.ts`); pohyblivá překážka zvlášť. */
function staticColliders(state: ArcadeState, layout: MinigolfLayout): MinigolfCollider[] {
  const out: MinigolfCollider[] = [];
  const add = (body: number, bounce: number, hop: boolean): void => {
    const b = bodyBase(body);
    out.push({ x: state[b + BODY.x] as number, z: state[b + BODY.z] as number, w: state[b + BODY.w] as number, d: state[b + BODY.d] as number, vx: 0, vz: 0, bounce, hop });
  };
  for (let i = 0; i < layout.rails[1]; i += 1) add(layout.rails[0] + i, MINIGOLF.railBounce, true);
  for (let i = 0; i < layout.bumpers[1]; i += 1) add(layout.bumpers[0] + i, MINIGOLF.bumperBounce, false);
  return out;
}

/** Nejmenší nabití, se kterým rána osou `axis` ujede aspoň `distance`: uzavřený vzorec, pak přesná oprava šikmé rány. */
export function minigolfChargeTo(axis: number, distance: number): number {
  let charge = Math.max(1, Math.min(BALL.maxCharge, Math.ceil((Math.sqrt(4 + 16 * Math.max(0, distance)) - 2) / 8)));
  while (charge > 1 && minigolfDistance(charge - 1) >= distance) charge -= 1;
  while (charge < BALL.maxCharge && minigolfDistance(charge) < distance) charge += 1;
  while (charge < BALL.maxCharge) {
    const rest = minigolfRest(axis, charge);
    if (sq(rest.dx) + sq(rest.dz) >= sq(distance)) break;
    charge += 1;
  }
  return charge;
}

/** Osa a nabití rány o `(dx, dz)`: míří na cíl, osu opraví o úhel, o který se klid rány na volné ploše od cíle stočil. */
export function minigolfAimAt(dx: number, dz: number): { readonly axis: number; readonly charge: number } {
  const distance = isqrt(sq(dx) + sq(dz));
  const want = minigolfAxisToward(dx, dz);
  let axis = want;
  let charge = minigolfChargeTo(axis, distance);
  for (let step = 0; step < MINIGOLF_BOT.aimSteps; step += 1) {
    const rest = minigolfRest(axis, charge);
    const miss = wrapAxis(want - minigolfAxisToward(rest.dx, rest.dz));
    if (miss === 0) break;
    axis = wrapAxis(axis + miss);
    charge = minigolfChargeTo(axis, distance);
  }
  return { axis, charge };
}

interface Cup {
  readonly x: number;
  readonly z: number;
  readonly size: number;
}

/** Rána z `from` osou `axis` s nabitím `charge`, tik po tiku jako ovládání a pravidlo jamky; `collidersAt(k)` = překážky k-tého tiku letu. */
function predict(from: Point, axis: number, charge: number, collidersAt: (k: number) => readonly MinigolfCollider[], cup: Cup): MinigolfShotPlan {
  const [svx, svz] = minigolfShot(axis, charge);
  let ball = { x: from[0], z: from[1], vx: svx, vz: svz };
  const path: Point[] = [];
  let bumped = false;
  for (let k = 0; k < MINIGOLF_BOT.horizon; k += 1) {
    const [fvx, fvz] = minigolfDamp(ball.vx, ball.vz);
    const next = minigolfRoll(ball, collidersAt(k));
    path.push([next.x, next.z]);
    if (next.vx !== fvx || next.vz !== fvz) bumped = true;
    if (next.hopped) return { axis, charge, path, holed: false, hopped: true, bumped, rest: [next.x, next.z] };
    if (4 * (sq(next.x - cup.x) + sq(next.z - cup.z)) <= sq(cup.size) && isqrt(sq(next.vx) + sq(next.vz)) <= MINIGOLF.holeSpeed) {
      return { axis, charge, path, holed: true, hopped: false, bumped, rest: [next.x, next.z] };
    }
    ball = next;
    if (ball.vx === 0 && ball.vz === 0) break;
  }
  return { axis, charge, path, holed: false, hopped: false, bumped, rest: [ball.x, ball.z] };
}

function cupOf(state: ArcadeState, layout: MinigolfLayout): Cup {
  const h = bodyBase(layout.hole);
  return { x: state[h + BODY.x] as number, z: state[h + BODY.z] as number, size: state[h + BODY.w] as number };
}

/**
 * Rána robota světa z místa `from` (bez pohyblivé překážky): první bod trasy od jamky zpět, kam rána dojede (jamka:
 * v jamce, zkusí i nabití o 1 vedle; roh: zastaví do `near` bez nárazu). Když žádný (míček leží mimo trasu), bod
 * s nejvyšším indexem, ke kterému se rána aspoň o polovinu přiblíží bez přeskoku mantinelu; jinak první bod trasy.
 */
export function minigolfPlan(state: ArcadeState, layout: MinigolfLayout, from: Point): MinigolfShotPlan {
  const colliders = staticColliders(state, layout);
  const still = (): readonly MinigolfCollider[] => colliders;
  const cup = cupOf(state, layout);
  const { route } = layout;
  const last = route.length - 1;
  const shots: (MinigolfShotPlan | null)[] = route.map((point, k) => {
    // Na rohu, u kterého míček už leží, se znovu nemíří.
    if (k < last && gap(from, point) <= MINIGOLF_BOT.near) return null;
    const { axis, charge } = minigolfAimAt(point[0] - from[0], point[1] - from[1]);
    const shot = predict(from, axis, charge, still, cup);
    if (k < last || shot.holed) return shot;
    for (const other of [charge + 1, charge - 1]) {
      if (other < 1 || other > BALL.maxCharge) continue;
      const tried = predict(from, axis, other, still, cup);
      if (tried.holed) return tried;
    }
    return shot;
  });
  for (let k = last; k >= 0; k -= 1) {
    const shot = shots[k];
    if (shot === null || shot === undefined) continue;
    if (shot.holed || (k < last && !shot.hopped && !shot.bumped && gap(shot.rest, route[k] as Point) <= MINIGOLF_BOT.near)) return shot;
  }
  for (let k = last; k >= 0; k -= 1) {
    const shot = shots[k];
    if (shot !== null && shot !== undefined && !shot.hopped && 2 * gap(shot.rest, route[k] as Point) <= gap(from, route[k] as Point)) return shot;
  }
  return shots.find((shot): shot is MinigolfShotPlan => shot !== null) as MinigolfShotPlan;
}

interface Mover {
  /** Kolizní těleso kutálení v tiku `tick` (poloha na začátku tiku, rychlost do dalšího – jako ve stavu jádra). */
  readonly at: (tick: number) => MinigolfCollider;
  readonly period: number;
}

/** Pohyblivá překážka ukotvená na stav, který robot vidí: stav s nohou kyvadla `leg` = fáze `leg` kyvadla `minigolfMoverAt`. */
function moverOf(state: ArcadeState, mover: number): Mover {
  const b = bodyBase(mover);
  const vx = state[b + BODY.vx] as number;
  const vz = state[b + BODY.vz] as number;
  const leg = state[b + BODY.aux0] as number;
  const period = state[b + BODY.aux1] as number;
  const seen = state[HEADER.tick] as number;
  const anchor = { x: (state[b + BODY.x] as number) - vx * leg, z: (state[b + BODY.z] as number) - vz * leg, vx, vz, period };
  const w = state[b + BODY.w] as number;
  const d = state[b + BODY.d] as number;
  return {
    period,
    at: (tick) => {
      const [x, z] = minigolfMoverAt(anchor, leg + tick - seen);
      const [nx, nz] = minigolfMoverAt(anchor, leg + tick + 1 - seen);
      return { x, z, w, d, vx: nx - x, vz: nz - z, bounce: MINIGOLF.bumperBounce, hop: false };
    },
  };
}

/** Překrývá míček v bodě `ball` těleso (po jeho pohybu v tiku) s odstupem `margin`? */
const touches = (ball: Point, c: MinigolfCollider, margin: number): boolean =>
  Math.abs(2 * (ball[0] - c.x - c.vx)) < c.w + MINIGOLF.ball + 2 * margin && Math.abs(2 * (ball[1] - c.z - c.vz)) < c.d + MINIGOLF.ball + 2 * margin;

/**
 * První tik puštění od `earliest` (do dvou period kyvadla), kdy stojící míček od `now` do puštění a celá rána pohyblivou
 * překážku minou: hrubé síto odstupem, pak kutálení s překážkou tik po tiku musí dát přesně dráhu bez ní. Bez okna `earliest`.
 */
function clearRelease(state: ArcadeState, layout: MinigolfLayout, mover: number, from: Point, plan: MinigolfShotPlan, now: number, earliest: number): number {
  const m = moverOf(state, mover);
  const statics = staticColliders(state, layout);
  const cup = cupOf(state, layout);
  for (let release = earliest; release <= earliest + 2 * m.period; release += 1) {
    let clear = true;
    for (let tick = now; clear && tick < release; tick += 1) clear = !touches(from, m.at(tick), 0);
    for (let k = 0; clear && k < plan.path.length; k += 1) clear = !touches(plan.path[k] as Point, m.at(release + k), MINIGOLF_BOT.moverMargin);
    if (!clear) continue;
    const real = predict(from, plan.axis, plan.charge, (k) => [...statics, m.at(release + k)], cup);
    if (real.path.length === plan.path.length && real.path.every((point, k) => point[0] === plan.path[k]?.[0] && point[1] === plan.path[k]?.[1])) return release;
  }
  return earliest;
}

/** Rozhodnutí robota (i slabého) nad stavem, který vidí. */
export function minigolfDecide(observation: { readonly state: ArcadeState; readonly player: number; readonly recent: readonly ArcadeInput[] }, params: MinigolfBotParams): ArcadeInput {
  const { state, player, recent } = observation;
  // Rána, kterou robot pustil a ještě ji nevidí, letí.
  if (recent.some((input) => (input.buttons & BUTTON.TAP) !== 0)) return NO_INPUT;
  const p = bodyBase(player);
  if ((state[p + BODY.vx] as number) !== 0 || (state[p + BODY.vz] as number) !== 0) return NO_INPUT;
  const { layout } = params;
  const from: Point = [state[p + BODY.x] as number, state[p + BODY.z] as number];
  const best = minigolfPlan(state, layout, from);
  const axis = wrapAxis(best.axis + params.aimError);
  const charge = Math.max(1, Math.min(BALL.maxCharge, Math.round((best.charge * params.powerPct) / 100)));
  const charged = Math.min(BALL.maxCharge, Math.max(0, state[p + BODY.aux1] as number) + recent.filter((input) => (input.buttons & BUTTON.HOLD) !== 0).length);
  if (charged >= charge) return { buttons: BUTTON.TAP, axis };
  if (charged > 0) return { buttons: BUTTON.HOLD, axis };
  if (layout.mover !== undefined) {
    const now = (state[HEADER.tick] as number) + recent.length;
    const statics = staticColliders(state, layout);
    const plan = axis === best.axis && charge === best.charge ? best : predict(from, axis, charge, () => statics, cupOf(state, layout));
    if (clearRelease(state, layout, layout.mover, from, plan, now, now + charge) > now + charge) return NO_INPUT;
  }
  return { buttons: BUTTON.HOLD, axis };
}

export const minigolfBot: BotPiece<MinigolfBotParams> = {
  id: 'minigolf_bot',
  params: botParams,
  roles: ['player'],
  cost: () => ({ bodies: 0, rules: 0 }),
  reactionTicks: MINIGOLF_BOT.reaction,
  decide: (observation, params) => minigolfDecide(observation, params),
};
