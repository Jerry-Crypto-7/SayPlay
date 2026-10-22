/**
 * Robot obrany pruhů (P54C T7): brání pruh s nepřítelem, který je hradbě nejblíž – s nejdřívějším
 * průlomem, kterého šípy ve vzduchu ještě nesrazí. V klidu (nejbližší takový průlom je dál než
 * `DEFENSE_CALM` tiků) drží v pruhu bez obránce, až tam obránce stojí. Bonus události (P55 T5) sestřelí
 * přednostně, ale jen když po té ráně stihne všechny nepřátele v obraze (`spareShot`).
 *
 * Svět vidí `reactionTicks` starý. Co od té doby udělal sám (vystřelené šípy, držení, pruh), si
 * dopočítá z vlastních vstupů stejně jako pravidlo `defense_shot`; nepřátelé jdou stálou rychlostí,
 * takže jejich polohu i tik průlomu dopočítá taky.
 */

import { z } from 'zod';

import { ARCADE_LIMITS, type ArcadeInput, type ArcadeObservation, BODY, BUTTON, type BotPiece, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, bodyHp } from '../contract';
import { LANES, axisOfLane, laneOf, laneOfAxis, laneOfX } from './lanes';
import { DEFENSE, DEFENSE_BOT_REACTION, breachStep, copiesOf } from './lane-defense';

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const botParams = z.object({ bolt: index, arrow: index, defender: index }).strict();
type DefenseBotParams = z.infer<typeof botParams>;

/** Klid: nejbližší nesražený nepřítel prolomí hradbu nejdřív za tolik tiků – robot staví obránce. */
export const DEFENSE_CALM = 150;

/** Pořadí pruhů pro obránce: od středu ven. */
const BUILD_ORDER = [2, 1, 3, 0, 4] as const;

/** Nepřítel, kterého šípy ve vzduchu nesrazí: pruh, krok průlomu a HP, které mu zbudou. */
export interface Threat {
  readonly body: number;
  readonly lane: number;
  readonly breach: number;
  readonly left: number;
}

export interface DefenseView {
  /** Tik, pro který robot volí. */
  readonly now: number;
  /** Luk je v tiku `now` nabitý. */
  readonly canFire: boolean;
  /** Tiky držení po vlastních vstupech (−1 = ťuk). */
  readonly held: number;
  /** Pruh hrdiny po vlastních vstupech. */
  readonly lane: number;
  /** Pruhy s obráncem (viděné i postavené vlastním držením). */
  readonly guarded: ReadonlySet<number>;
  /** Nesražení nepřátelé v obraze podle průlomu, nejdřívější první. */
  readonly threats: readonly Threat[];
  /** Bonusy událostí v obraze, na které ještě neletí šíp, podle odchodu k hradbě (`breach`), nejdřívější první. */
  readonly bonuses: readonly Threat[];
}

/** Rezerva (tiky), kterou robotu po ráně do bonusu musí nechat každý nepřítel v obraze. */
export const DEFENSE_BONUS_SLACK = 30;

/**
 * Smí robot vystřelit na bonus? Jen když po té ráně ještě stihne všechny nepřátele v obraze v pořadí
 * průlomu (každé HP jedna rána po `reload`) s rezervou `DEFENSE_BONUS_SLACK`.
 */
export function spareShot(view: DefenseView): boolean {
  let shots = 1;
  for (const threat of view.threats) {
    shots += threat.left;
    if (threat.breach - view.now < DEFENSE.reload * (shots - 1) + DEFENSE_BONUS_SLACK) return false;
  }
  return true;
}

/** Co robot ví v tiku `now`: viděný stav plus vlastní vstupy od té doby. */
export function defenseView({ state, player, tick: seenAt, recent }: ArcadeObservation, params: DefenseBotParams): DefenseView {
  const now = seenAt + recent.length;
  let cooldown = state[HEADER.counters + COUNTER.cooldown] as number;
  let held = state[bodyBase(player) + BODY.aux1] as number;
  let lane = laneOf(state, player);
  const guarded = new Set(copiesOf(state, params.defender).map((body) => laneOfX(state[bodyBase(body) + BODY.x] as number)));
  const shots = Array.from({ length: LANES.count }, () => 0);
  for (const body of [...copiesOf(state, params.bolt), ...copiesOf(state, params.arrow)]) shots[laneOfX(state[bodyBase(body) + BODY.x] as number)]! += 1;
  for (const input of recent) {
    if (input.axis !== 0) lane = laneOfAxis(input.axis);
    if ((input.buttons & BUTTON.LEFT) !== 0) lane = Math.max(0, lane - 1);
    if ((input.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(LANES.count - 1, lane + 1);
    const tap = (input.buttons & BUTTON.TAP) !== 0;
    held = tap ? -1 : (input.buttons & BUTTON.HOLD) !== 0 ? Math.max(0, held) + 1 : 0;
    if (tap && cooldown === 0) {
      shots[lane]! += 1;
      cooldown = DEFENSE.reload - 1;
    } else if (cooldown > 0) cooldown -= 1;
    if (held === DEFENSE.hold) guarded.add(lane);
  }
  // Nepřátelé v obraze po pruzích, čelem ke hradbě první; šípy ve vzduchu srazí nejdřív ty vpředu.
  const elapsed = now - seenAt;
  const foes: (Threat & { readonly z: number; readonly bonus: boolean })[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    const role = state[base + BODY.role];
    if ((role !== ROLE.chaser && role !== ROLE.collectible) || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    // Jen co viděný stav ukazuje: nepřítel ještě v mlze (za `far`) robot nezná, i když už vyšel.
    if ((state[base + BODY.z] as number) > DEFENSE.far) continue;
    const speed = -(state[base + BODY.vz] as number);
    const z = (state[base + BODY.z] as number) - speed * elapsed;
    const breach = breachStep(z, speed, state[base + BODY.d] as number, now);
    // Bonus (P55 T5) má jednu „ránu“; ten, který k hradbě dojde dřív, než k němu šíp doletí, už nehoní.
    const bonus = role === ROLE.collectible;
    if (bonus && breach - now < 3) continue;
    foes.push({ body, z, lane: laneOfX(state[base + BODY.x] as number), breach, left: bonus ? 1 : bodyHp(state, body), bonus });
  }
  foes.sort((a, b) => a.z - b.z || a.body - b.body);
  const threats: Threat[] = [];
  const bonuses: Threat[] = [];
  for (const foe of foes) {
    const spent = Math.min(foe.left, shots[foe.lane]!);
    shots[foe.lane]! -= spent;
    if (foe.left > spent) (foe.bonus ? bonuses : threats).push({ body: foe.body, lane: foe.lane, breach: foe.breach, left: foe.left - spent });
  }
  threats.sort((a, b) => a.breach - b.breach || a.body - b.body);
  bonuses.sort((a, b) => a.breach - b.breach || a.body - b.body);
  return { now, canFire: cooldown === 0, held, lane, guarded, threats, bonuses };
}

export const defenseBot: BotPiece<DefenseBotParams> = {
  id: 'defense_bot',
  params: botParams,
  roles: ['player', 'chaser'],
  reactionTicks: DEFENSE_BOT_REACTION,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: (observation, params): ArcadeInput => {
    const view = defenseView(observation, params);
    const first = view.threats[0];
    // Bonus události sestřelí, jen když to žádného nepřítele neohrozí.
    const bonus = view.bonuses[0];
    if (bonus !== undefined && view.canFire && spareShot(view)) return { buttons: BUTTON.TAP, axis: axisOfLane(bonus.lane) };
    const fire = first !== undefined && view.canFire ? { buttons: BUTTON.TAP, axis: axisOfLane(first.lane) } : NO_INPUT;
    const free = BUILD_ORDER.filter((lane) => !view.guarded.has(lane));
    if ((first !== undefined && first.breach - view.now < DEFENSE_CALM) || free.length === 0) return fire;
    // Držení došlo (obránce stojí, nebo pruh už jednoho měl): pustit, ať další držení počítá od nuly.
    if (view.held >= DEFENSE.hold) return fire;
    const lane = view.held > 0 && !view.guarded.has(view.lane) ? view.lane : (free[0] as number);
    return { buttons: BUTTON.HOLD, axis: axisOfLane(lane) };
  },
};
