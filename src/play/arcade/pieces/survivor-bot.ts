/**
 * Robot přežití ve vlnách (P66 T5). Střílí se samo, robot jen volí, kam jít: z 32 směrů a stání vybere ten, po kterém
 * je hrdina v příští ⅓ s nejdál od nepřátel, koulí bosse, čáry jeho rozběhu a dosahu dupnutí, ne u stěny, a přitom
 * má nepřítele v dostřelu (jinak by nestřílel). Bez hrozby blízko jde pro krystaly. Vidí stav o reakci starší a polohy
 * těl posune o jejich rychlost; vylepšení volí obal háčků `hooks_bot` (`UPGRADE_PRIORITY`).
 *
 * **Práh chyb** (`errors`, ‰): v tolika oknech po `SURVIVOR_BOT.window` tiků robot stojí – slabý robot pro test, že hra
 * jde prohrát. Okna vybírá pevná celočíselná funkce okna (bez náhody), takže je i slabý robot deterministický. Robot
 * světa ho nemá (0).
 *
 * Jen sčítání, násobení, dělení a `Math.sqrt` (v IEEE 754 přesně zaokrouhlené): Node i prohlížeč zvolí týž směr.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeObservation, type ArcadeState, BODY, type BotPiece, NO_INPUT, bodyBase } from '../contract';
import { inBreak, offerOf, upgradeLevel } from '../hooks';
import { UPGRADE_PICK_BUTTONS, type UpgradeId } from '../hooks/contract';
import { PICK_MASK } from '../hooks/upgrades';
import { DIRECTIONS, arenaAxis } from './arena';
import { BOSS, BOSS_ATTACK_CODES, BOSS_PHASE, SURVIVOR, SURVIVOR_BODIES, bossAimOf, bossAttackIndexOf, bossOf, bossPhaseOf, copiesOf, enemiesOf, isBoss, rangeAt } from './survivor-world';

export const SURVIVOR_BOT = {
  /** Kam dopředu robot počítá (tiky po krocích `step`). */
  horizon: 30,
  step: 6,
  /** Nepřítel, který právě vstoupil (stojí), jde za hrdinou aspoň touhle rychlostí (j/tik). */
  chase: 60,
  /** Mezera mezi okraji těl, pod kterou je nepřítel hrozba (j). */
  safe: 1400,
  /** Od stěny drží aspoň tolik (j). */
  wall: 2200,
  /** Čára rozběhu bosse: délka a polovina šířky nebezpečného pásu nad poloměr bosse (j). */
  charge: { reach: 8000, width: 1900 },
  /** Kolik nad dosah dupnutí drží (j). */
  stomp: 900,
  /** Okno práhu chyb (tiky). */
  window: 30,
  /** Reakce robota (tiky) – jako každý robot knihovny; o tolik posouvá polohy. */
  reaction: 8,
} as const;

const botParams = z
  .object({
    /** Počítadlo háčků (stupeň `range` = dostřel). */
    hooks: z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1),
    /** Útoky bosse v cyklu, jak je nese ovládání. */
    attacks: z.array(z.enum(BOSS_ATTACK_CODES)).min(1).max(3),
    /** Práh chyb (‰ oken, kdy robot stojí); 0 = robot světa. */
    errors: z.int().min(0).max(1000).default(0),
  })
  .strict();
export type SurvivorBotParams = z.infer<typeof botParams>;

interface Threat {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  /** Poloměr těla (j). */
  readonly r: number;
  /** Jde za hrdinou rychlostí `speed` (nepřítel), nebo jede rovně svou rychlostí (boss, koule). */
  readonly chases: boolean;
  readonly speed: number;
  readonly weight: number;
}

interface Hero {
  readonly x: number;
  readonly z: number;
}

/** Stojí slabý robot v okně tiku `tick`? Pevná celočíselná funkce okna (multiplikativní hash), ne náhoda. */
export function blunders(tick: number, errors: number): boolean {
  if (errors <= 0) return false;
  const window = Math.floor(tick / SURVIVOR_BOT.window);
  return (Math.imul(window + 1, 2654435761) >>> 0) % 1000 < errors;
}

const sq = (value: number): number => value * value;

function threatsOf(state: ArcadeState, lag: number): Threat[] {
  const out: Threat[] = [];
  for (const i of enemiesOf(state)) {
    const base = bodyBase(i);
    const big = isBoss(state, i);
    const vx = state[base + BODY.vx] as number;
    const vz = state[base + BODY.vz] as number;
    out.push({
      x: (state[base + BODY.x] as number) + vx * lag,
      z: (state[base + BODY.z] as number) + vz * lag,
      vx,
      vz,
      r: (state[base + BODY.w] as number) / 2,
      chases: !big,
      speed: Math.max(SURVIVOR_BOT.chase, Math.sqrt(vx * vx + vz * vz)),
      weight: big ? 3 : 1,
    });
  }
  for (const i of copiesOf(state, SURVIVOR_BODIES.orb)) {
    const base = bodyBase(i);
    const vx = state[base + BODY.vx] as number;
    const vz = state[base + BODY.vz] as number;
    out.push({ x: (state[base + BODY.x] as number) + vx * lag, z: (state[base + BODY.z] as number) + vz * lag, vx, vz, r: SURVIVOR.orb.w / 2, chases: false, speed: 0, weight: 2 });
  }
  return out;
}

/** Vzdálenost bodu od úsečky `a → a + d·reach` (d jednotkový × 1000). */
function lineGap(px: number, pz: number, ax: number, az: number, dx: number, dz: number, reach: number): number {
  const along = Math.max(0, Math.min(reach, ((px - ax) * dx + (pz - az) * dz) / 1000));
  return Math.sqrt(sq(px - (ax + (dx * along) / 1000)) + sq(pz - (az + (dz * along) / 1000)));
}

/** Co boss chystá: čára rozběhu, kruh dupnutí, nebo nic. */
type BossDanger = { readonly kind: 'charge'; readonly x: number; readonly z: number; readonly dx: number; readonly dz: number } | { readonly kind: 'stomp'; readonly x: number; readonly z: number } | null;

function bossDanger(state: ArcadeState, attacks: SurvivorBotParams['attacks']): BossDanger {
  const boss = bossOf(state);
  if (boss < 0) return null;
  const phase = bossPhaseOf(state, boss);
  if (phase !== BOSS_PHASE.telegraph && phase !== BOSS_PHASE.act) return null;
  const base = bodyBase(boss);
  const x = state[base + BODY.x] as number;
  const z = state[base + BODY.z] as number;
  const attack = attacks[bossAttackIndexOf(state, boss)];
  if (attack === 'charge') {
    const aim = DIRECTIONS[bossAimOf(state, boss)] as { dx: number; dz: number };
    return { kind: 'charge', x, z, dx: aim.dx, dz: aim.dz };
  }
  return attack === 'stomp' && phase === BOSS_PHASE.telegraph ? { kind: 'stomp', x, z } : null;
}

/**
 * Cena kroku po směru `dir` (−1 = stát): hrozby v časech `step … horizon`, stěny, útok bosse, mimo dostřel, krystaly
 * a mírně ke středu. Menší je lepší.
 */
function costOf(state: ArcadeState, hero: Hero, dir: number, threats: readonly Threat[], danger: BossDanger, range: number): number {
  const { halfX, halfZ } = SURVIVOR;
  const heroR = SURVIVOR.hero.w / 2;
  const limitX = halfX - heroR;
  const limitZ = halfZ - heroR;
  const unit = dir < 0 ? { dx: 0, dz: 0 } : (DIRECTIONS[dir] as { dx: number; dz: number });
  let cost = 0;
  let near = Number.MAX_SAFE_INTEGER;
  let x = hero.x;
  let z = hero.z;
  for (let t: number = SURVIVOR_BOT.step; t <= SURVIVOR_BOT.horizon; t += SURVIVOR_BOT.step) {
    x = Math.max(-limitX, Math.min(limitX, hero.x + (unit.dx * SURVIVOR.speed * t) / 1000));
    z = Math.max(-limitZ, Math.min(limitZ, hero.z + (unit.dz * SURVIVOR.speed * t) / 1000));
    for (const threat of threats) {
      let ex = threat.x + threat.vx * t;
      let ez = threat.z + threat.vz * t;
      if (threat.chases) {
        const gx = x - threat.x;
        const gz = z - threat.z;
        const gap = Math.sqrt(gx * gx + gz * gz) || 1;
        const run = Math.min(gap, threat.speed * t);
        ex = threat.x + (gx * run) / gap;
        ez = threat.z + (gz * run) / gap;
      }
      const d = Math.sqrt(sq(x - ex) + sq(z - ez)) - threat.r - heroR;
      if (d < SURVIVOR_BOT.safe) cost += (sq(SURVIVOR_BOT.safe - d) * threat.weight) / 1000;
      if (t === SURVIVOR_BOT.horizon) near = Math.min(near, d);
    }
    // Bok od stěny: roh je past.
    const wx = halfX - Math.abs(x);
    const wz = halfZ - Math.abs(z);
    if (wx < SURVIVOR_BOT.wall) cost += sq(SURVIVOR_BOT.wall - wx) / 1500;
    if (wz < SURVIVOR_BOT.wall) cost += sq(SURVIVOR_BOT.wall - wz) / 1500;
  }
  if (danger !== null && danger.kind === 'charge') {
    const band = SURVIVOR_BOT.charge.width + SURVIVOR.boss.w / 2;
    const gap = lineGap(x, z, danger.x, danger.z, danger.dx, danger.dz, SURVIVOR_BOT.charge.reach);
    if (gap < band) cost += sq(band - gap) / 100;
  } else if (danger !== null) {
    const reach = BOSS.stomp.radius + SURVIVOR_BOT.stomp;
    const gap = Math.sqrt(sq(x - danger.x) + sq(z - danger.z));
    if (gap < reach) cost += sq(reach - gap) / 100;
  }
  // Nepřítel v dostřelu = střílí se; bez něj se kolo neposune.
  if (threats.length > 0 && near + SURVIVOR.enemy.w > range) cost += (near + SURVIVOR.enemy.w - range) / 4;
  // Krystaly, když je klid.
  if (near > 2 * SURVIVOR_BOT.safe) {
    let crystal = Number.MAX_SAFE_INTEGER;
    for (const i of copiesOf(state, SURVIVOR_BODIES.crystal)) {
      const base = bodyBase(i);
      crystal = Math.min(crystal, Math.sqrt(sq(x - (state[base + BODY.x] as number)) + sq(z - (state[base + BODY.z] as number))));
    }
    if (crystal < Number.MAX_SAFE_INTEGER) cost += crystal / 40;
  }
  // Mírně ke středu: odtud vedou cesty všude.
  return cost + Math.sqrt(sq(x) + sq(z)) / 60;
}

/** Směr (0..31) s nejmenší cenou, nebo −1 = stát; shoda ceny = nižší index. */
export function bestDirection(state: ArcadeState, player: number, params: SurvivorBotParams): number {
  const lag = SURVIVOR_BOT.reaction;
  const p = bodyBase(player);
  const hero = { x: (state[p + BODY.x] as number) + (state[p + BODY.vx] as number) * lag, z: (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * lag };
  const threats = threatsOf(state, lag);
  const danger = bossDanger(state, params.attacks);
  const range = rangeAt(upgradeLevel(state, params.hooks, 'range'));
  let best = -1;
  let bestCost = costOf(state, hero, -1, threats, danger, range);
  for (let dir = 0; dir < 32; dir += 1) {
    const cost = costOf(state, hero, dir, threats, danger, range);
    if (cost < bestCost) {
      best = dir;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Pořadí, ve kterém robot přežití bere karty: rána napřed (boss padne dřív, než ho posily obstoupí), dostřel jen první
 * stupeň (další už ránu skoro nezrychlí), pak život, další dostřel, pohyb a magnet. Pevné, takže deterministické;
 * obecné pořadí háčků (`UPGRADE_PRIORITY`, život napřed) by v nabídkách bez rány nechalo robota s ránou na začátku
 * a boss by ho přečkal.
 */
export const SURVIVOR_PICK_PRIORITY: readonly (readonly [UpgradeId, number])[] = [
  ['fire_rate', 3],
  ['range', 1],
  ['extra_life', 3],
  ['range', 3],
  ['speed', 3],
  ['magnet', 3],
];

/** Karta, kterou robot z nabídky bere: první z `SURVIVOR_PICK_PRIORITY`, jejíž stupeň je pod mezí; jinak karta 0. */
export function survivorPick(offer: readonly UpgradeId[], level: (id: UpgradeId) => number): number {
  const wanted = SURVIVOR_PICK_PRIORITY.find(([id, below]) => offer.includes(id) && level(id) < below)?.[0];
  return wanted === undefined ? 0 : offer.indexOf(wanted);
}

/** V přestávce s nabídkou stiskne jednou kartu podle `survivorPick`; stisk, který stav ještě neukazuje, nese `recent`. */
function pickInBreak(observation: ArcadeObservation, hooks: number): ArcadeInput {
  const offer = offerOf(observation.state, hooks);
  if (offer === null || observation.recent.some((input) => (input.buttons & PICK_MASK) !== 0)) return NO_INPUT;
  const card = survivorPick(offer, (id) => upgradeLevel(observation.state, hooks, id));
  return { buttons: UPGRADE_PICK_BUTTONS[card] as number, axis: 0 };
}

export const survivorBot: BotPiece<SurvivorBotParams> = {
  id: 'survivor_bot',
  params: botParams,
  roles: ['player'],
  // Jako každý robot knihovny.
  reactionTicks: SURVIVOR_BOT.reaction,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: (observation: ArcadeObservation, params) => {
    // V přestávce svět stojí: jen volba karty.
    if (inBreak(observation.state, params.hooks)) return pickInBreak(observation, params.hooks);
    if (blunders(observation.tick, params.errors)) return NO_INPUT;
    const dir = bestDirection(observation.state, observation.player, params);
    if (dir < 0) return NO_INPUT;
    const { dx, dz } = DIRECTIONS[dir] as { dx: number; dz: number };
    return { buttons: 0, axis: arenaAxis(dx, dz) };
  },
};
