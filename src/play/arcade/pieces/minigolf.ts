/**
 * Minigolf (P68 T6, kategorie `vozidla-sport`): jedna jamka, míček kutálený celočíselně v jádře, rány a par.
 *
 * - **Ovládání `minigolf`** má sémantiku `ballControl` (P41): osa = směr (`minigolfAim`, drží se v `aux0` hráče a tik
 *   s `HOLD` nebo `TAP` ji vždy přepíše – vstup ji nese s nabíjením jako `ball-input`), `HOLD` = nabíjení do
 *   `BALL.maxCharge` (`aux1`), `DOWN` = zrušení, `TAP` = rána – jen když míček stojí; puštění za pohybu ránu
 *   nedá a nabití zahodí. Hráč **je** míček: kutálení (`minigolfRoll`) spočítá konec tiku včetně odrazů a polohu
 *   zapíše o rychlost zpět, protože jádro po ovládání rychlost k poloze přičte (`integrate`).
 * - **Pravidlo `minigolf_hole`** (tik): míček nad jamkou s rychlostí nejvýš `holeSpeed` = výhra a skóre
 *   `minigolfScore`; střed míčku mimo dlaždice (přeskočil mantinel) = návrat na místo poslední rány + 1 rána;
 *   stojící míček po vyčerpání limitu ran (par + 3) nebo poslední tik horizontu (`ARCADE_LIMITS.maxTicks`) = prohra.
 * - **Generátor `minigolf_course`**: `minigolf-hole.ts`.
 *
 * Stav pro HUD, robota a scénu: rány, par a návraty z mimo dráhy v čítačích (`MINIGOLF_COUNTER`), míření a nabití
 * v `aux0` / `aux1` hráče, místo poslední rány v `HEADER.respawnX/Z`, rozložení světa v parametrech (`MinigolfLayout`).
 */

import { z } from 'zod';

import { ARCADE_LIMITS, AXIS_MAX, AXIS_MIN, type ArcadeCounter, type ArcadeState, BODY, BUTTON, COUNTER, type ControlPiece, HEADER, type ModeGeneratorPiece, type ModeParts, type RulePiece, bodyBase } from '../contract';
import { BALL } from './ball';
import { type MinigolfCourse, type MinigolfLayout, type MinigolfParams, checkMinigolfHole, drawMinigolfCourse, minigolfLayout, minigolfLevelOf, minigolfParams } from './minigolf-hole';
import { MINIGOLF, type MinigolfCollider, isqrt, minigolfRoll, minigolfShot } from './minigolf-roll';

/** Čítače minigolfu: rány, par jamky, návraty z mimo dráhy. Pevné sloty hlavičky (`COUNTER`), které hra jinak nepoužívá. */
export const MINIGOLF_COUNTER = { strokes: 'ammo', par: 'reserve', outOfBounds: 'items' } as const satisfies Readonly<Record<string, ArcadeCounter>>;
const counterAt = (name: keyof typeof MINIGOLF_COUNTER): number => HEADER.counters + COUNTER[MINIGOLF_COUNTER[name]];
export const strokesOf = (state: ArrayLike<number>): number => state[counterAt('strokes')] as number;
export const parOf = (state: ArrayLike<number>): number => state[counterAt('par')] as number;
export const outOfBoundsOf = (state: ArrayLike<number>): number => state[counterAt('outOfBounds')] as number;

/** Limit ran jamky s parem `par`. */
export const minigolfLimit = (par: number): number => par + MINIGOLF.extraStrokes;
/** Skóre výhry: čím víc pod limitem, tím víc – rána do jamky na par 3 = 600, par = 400, poslední povolená = 100. */
export const minigolfScore = (par: number, strokes: number): number => MINIGOLF.scorePerStroke * (minigolfLimit(par) + 1 - strokes);

const layoutParams = z.object({ layout: minigolfLayout }).strict();
type LayoutParams = z.infer<typeof layoutParams>;

/** Překážky kutálení ze stavu: mantinely (přeskočitelné), odrazníky, pohyblivá překážka se svou rychlostí tiku. */
function collidersOf(state: ArcadeState, layout: MinigolfLayout): MinigolfCollider[] {
  const colliders: MinigolfCollider[] = [];
  const add = (body: number, bounce: number, hop: boolean): void => {
    const b = bodyBase(body);
    colliders.push({ x: state[b + BODY.x] as number, z: state[b + BODY.z] as number, w: state[b + BODY.w] as number, d: state[b + BODY.d] as number, vx: state[b + BODY.vx] as number, vz: state[b + BODY.vz] as number, bounce, hop });
  };
  for (let i = 0; i < layout.rails[1]; i += 1) add(layout.rails[0] + i, MINIGOLF.railBounce, true);
  for (let i = 0; i < layout.bumpers[1]; i += 1) add(layout.bumpers[0] + i, MINIGOLF.bumperBounce, false);
  if (layout.mover !== undefined) add(layout.mover, MINIGOLF.bumperBounce, false);
  return colliders;
}

export const minigolfControl: ControlPiece<LayoutParams> = {
  id: 'minigolf',
  params: layoutParams,
  roles: ['player', 'obstacle'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step(state, player, input, { layout }) {
    const p = bodyBase(player);
    const { buttons } = input;
    if (input.axis !== 0 || (buttons & (BUTTON.HOLD | BUTTON.TAP)) !== 0) state[p + BODY.aux0] = Math.max(AXIS_MIN, Math.min(AXIS_MAX, input.axis));
    let charge = Math.max(0, state[p + BODY.aux1] as number);
    if ((buttons & BUTTON.DOWN) !== 0) charge = 0;
    else if ((buttons & BUTTON.HOLD) !== 0) charge = Math.min(BALL.maxCharge, charge + 1);
    let vx = state[p + BODY.vx] as number;
    let vz = state[p + BODY.vz] as number;
    if ((buttons & BUTTON.TAP) !== 0) {
      if (vx === 0 && vz === 0) {
        [vx, vz] = minigolfShot(state[p + BODY.aux0] as number, Math.max(1, charge));
        state[HEADER.respawnX] = state[p + BODY.x] as number;
        state[HEADER.respawnZ] = state[p + BODY.z] as number;
        state[counterAt('strokes')] = strokesOf(state) + 1;
      }
      charge = 0;
    }
    state[p + BODY.aux1] = charge;
    const ball = minigolfRoll({ x: state[p + BODY.x] as number, z: state[p + BODY.z] as number, vx, vz }, collidersOf(state, layout));
    state[p + BODY.x] = ball.x - ball.vx;
    state[p + BODY.z] = ball.z - ball.vz;
    state[p + BODY.vx] = ball.vx;
    state[p + BODY.vz] = ball.vz;
  },
};

/** Leží bod `x/z` na některé dlaždici dráhy (hrana platí)? */
function onCourse(state: ArcadeState, layout: MinigolfLayout, x: number, z: number): boolean {
  for (let i = 0; i < layout.floor[1]; i += 1) {
    const t = bodyBase(layout.floor[0] + i);
    if (Math.abs(2 * (x - (state[t + BODY.x] as number))) <= (state[t + BODY.w] as number) && Math.abs(2 * (z - (state[t + BODY.z] as number))) <= (state[t + BODY.d] as number)) return true;
  }
  return false;
}

export const minigolfHoleRule: RulePiece<LayoutParams> = {
  id: 'minigolf_hole',
  params: layoutParams,
  roles: ['player', 'goal', 'platform'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire({ state, player }, { layout }) {
    const p = bodyBase(player);
    const h = bodyBase(layout.hole);
    const x = state[p + BODY.x] as number;
    const z = state[p + BODY.z] as number;
    const vx = state[p + BODY.vx] as number;
    const vz = state[p + BODY.vz] as number;
    const dx = x - (state[h + BODY.x] as number);
    const dz = z - (state[h + BODY.z] as number);
    const size = state[h + BODY.w] as number;
    if (4 * (dx * dx + dz * dz) <= size * size && isqrt(vx * vx + vz * vz) <= MINIGOLF.holeSpeed) {
      return [{ kind: 'score', amount: minigolfScore(parOf(state), strokesOf(state)) }, { kind: 'win' }];
    }
    if (!onCourse(state, layout, x, z)) {
      return [{ kind: 'respawn' }, { kind: 'count', counter: MINIGOLF_COUNTER.strokes, amount: 1 }, { kind: 'count', counter: MINIGOLF_COUNTER.outOfBounds, amount: 1 }];
    }
    const spent = vx === 0 && vz === 0 && strokesOf(state) >= minigolfLimit(parOf(state));
    if (spent || (state[HEADER.tick] as number) + 1 >= ARCADE_LIMITS.maxTicks) return [{ kind: 'lose' }];
    return [];
  },
};

export const MINIGOLF_RULES: Readonly<Record<string, RulePiece>> = { minigolf_hole: minigolfHoleRule as RulePiece };

/** Díly světa z jamky (i ruční v testech a u robota): ovládání, robot a pravidlo dostanou totéž rozložení. */
export function minigolfPartsOf(course: MinigolfCourse): ModeParts {
  const { level, layout } = minigolfLevelOf(course);
  const placed = layout.bumpers[1];
  return {
    control: { id: 'minigolf', params: { layout } },
    bot: { id: 'minigolf_bot', params: { layout } },
    level,
    rules: [{ id: 'minigolf_hole', params: { layout } }],
    issues: [...(placed < course.obstacles ? [`minigolf: only ${String(placed)} of ${String(course.obstacles)} obstacles fit`] : []), ...checkMinigolfHole(level, layout)],
  };
}

export const minigolfParts = (seed: number, params: MinigolfParams): ModeParts => minigolfPartsOf(drawMinigolfCourse(seed, params));

export const minigolfCourse: ModeGeneratorPiece<MinigolfParams> = {
  id: 'minigolf_course',
  params: minigolfParams,
  roles: ['player', 'goal', 'platform', 'obstacle'],
  // Nejvýš: míček, jamka, 7 dlaždic S, 14 mantinelů, 3 odrazníky, pohyblivá.
  cost: () => ({ bodies: 26, rules: 1 }),
  generate: (seed, params) => minigolfParts(seed, params).level,
  parts: (seed, params) => minigolfParts(seed, params),
};
