/**
 * Robot obrany pruhů (P54C T7): brání pruh s nepřítelem, který je hradbě nejblíž – s nejdřívějším
 * průlomem, kterého šípy ve vzduchu ještě nesrazí. V klidu (nejbližší takový průlom je dál než
 * `DEFENSE_CALM` tiků) drží v pruhu bez obránce, až tam obránce stojí.
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
  const foes: (Threat & { readonly z: number })[] = [];
  for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
    const base = bodyBase(body);
    if (state[base + BODY.role] !== ROLE.chaser || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    // Jen co viděný stav ukazuje: nepřítel ještě v mlze (za `far`) robot nezná, i když už vyšel.
    if ((state[base + BODY.z] as number) > DEFENSE.far) continue;
    const speed = -(state[base + BODY.vz] as number);
    const z = (state[base + BODY.z] as number) - speed * elapsed;
    foes.push({ body, z, lane: laneOfX(state[base + BODY.x] as number), breach: breachStep(z, speed, state[base + BODY.d] as number, now), left: bodyHp(state, body) });
  }
  foes.sort((a, b) => a.z - b.z || a.body - b.body);
  const threats: Threat[] = [];
  for (const foe of foes) {
    const spent = Math.min(foe.left, shots[foe.lane]!);
    shots[foe.lane]! -= spent;
    if (foe.left > spent) threats.push({ body: foe.body, lane: foe.lane, breach: foe.breach, left: foe.left - spent });
  }
  threats.sort((a, b) => a.breach - b.breach || a.body - b.body);
  return { now, canFire: cooldown === 0, held, lane, guarded, threats };
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
    const fire = first !== undefined && view.canFire ? { buttons: BUTTON.TAP, axis: axisOfLane(first.lane) } : NO_INPUT;
    const free = BUILD_ORDER.filter((lane) => !view.guarded.has(lane));
    if ((first !== undefined && first.breach - view.now < DEFENSE_CALM) || free.length === 0) return fire;
    // Držení došlo (obránce stojí, nebo pruh už jednoho měl): pustit, ať další držení počítá od nuly.
    if (view.held >= DEFENSE.hold) return fire;
    const lane = view.held > 0 && !view.guarded.has(view.lane) ? view.lane : (free[0] as number);
    return { buttons: BUTTON.HOLD, axis: axisOfLane(lane) };
  },
};
