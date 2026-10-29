/**
 * Třídění (P66 T8): fronty věcí z věty nahoře, nádoby dole; ťuk do sloupce fronty (vstup pruhů, `laneOfAxis`) pošle
 * její čelo do nádoby téhož druhu nebo barvy, jinak do odkladiště s omezeným místem. Plné odkladiště = prohra, hodiny
 * kola (minuta) taky. Hra a její meze jsou v `sort-level.ts`; tady je ovládání, pravidlo a generátor.
 *
 * **Kola** (háčky `arcade/hooks`, `clear: 'win'`): pravidlo vyhlásí výhru, když jsou všechny nádoby kola hotové; před
 * posledním kolem z ní háčky udělají vyčištěné kolo s přestávkou a pak hned další kolo z `roundOf`. Věci všech kol
 * jsou tělesa úrovně od začátku (vzácnost dostanou v tiku 0, `rarity.ts`), věci pozdějších kol čekají za scénou.
 *
 * **Tělo věci:** role `collectible`, druh 0–4 v HP (`hp = druh + 1`), fronta v `x`, v odkladišti stav cíle
 * `SORT_BUFFERED`, v nádobě mrtvá (`despawn`). Ovládání každý tik (mimo přestávku, kdy svět stojí) rozestaví věci
 * běžícího kola: čelo fronty do první řady, odkladiště po místech – létající skóre háčků tak vzlétne z věci, kterou
 * hráč poslal, a z odkladiště z místa, odkud věc přeskočila.
 *
 * **Počítadlo třídění** (mrtvá předloha za tělesy úrovně jako počítadlo háčků): `x` = tiky běžícího kola, `y` = kolo,
 * pro které běží, `z` = tik posledního ťuku (robot podle něj drží tempo).
 *
 * **Body a kombo:** věc poslaná rovnou do nádoby dá `points` × kombo a zvedne sérii (`nextMultiplier` s oknem
 * `SORT.comboWindow`); věc do odkladiště sérii shodí. Věc, která z odkladiště přeskočí sama, dá body bez komba.
 * Dvojice `score` + `despawn` je sebrání pro vzácnost háčků (body × 3 / × 10, nález ve výsledku).
 */

import { z } from 'zod';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  BUTTON,
  type BodyInit,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  type RulePiece,
  bodyBase,
  bodyHp,
  targetStateOf,
} from '../contract';
import { roundOf, withHooks } from '../hooks';
import { LANES, LANE_START, laneOf, laneOfAxis, tappedIn } from './lanes';
import { nextMultiplier } from './rules';
import {
  SORT,
  SORT_BUFFERED,
  SORT_LAYOUT,
  type SortBoard,
  type SortItem,
  type SortRound,
  binsPerRound,
  firstLane,
  queueOfX,
  queueX,
  rowZ,
  slotX,
  sortRounds,
  tapQueue,
} from './sort-level';

export { SORT, SORT_LAYOUT } from './sort-level';

const body = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

/** Kolo ve hře: rozsah těl jeho věcí, pořadí nádob (druhy jako číslice), viditelné nádoby a fronty. */
const roundSchema = z
  .object({
    start: body,
    count: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
    bins: z.string().regex(/^[0-4]{1,32}$/),
    show: z.int().min(1).max(5),
    queues: z.int().min(1).max(LANES.count),
  })
  .strict();

/** Co o hře vědí ovládání, pravidlo i robot: počítadlo třídění, počítadlo háčků (kolo), meze a kola. */
const gameShape = {
  board: body,
  keeper: body,
  slots: z.int().min(2).max(8),
  capacity: z.int().min(1).max(6),
  /** Hodiny kola (tiky). */
  ticks: z.int().min(ARCADE_HZ).max(ARCADE_LIMITS.maxTicks),
  rounds: z.array(roundSchema).min(1).max(SORT.rounds.max),
};
export const sortGameSchema = z.object(gameShape).strict();
export type SortGame = z.infer<typeof sortGameSchema>;

/** Kolo hry, které právě běží (počítadlo háčků; za posledním se drží posledního). */
export const roundIn = (state: Int32Array, game: SortGame): number => Math.min(game.rounds.length - 1, roundOf(state, game.keeper));

/** Pořadí nádob kola jako čísla druhů. */
export const binsOf = (round: SortGame['rounds'][number]): number[] => [...round.bins].map(Number);

/** Kolo `round` ze stavu: fronty podle `x` věcí (pořadí těl = pořadí ve frontě), odkladiště a věci v nádobách. */
export function boardOfState(state: Int32Array, game: SortGame, round: number): SortBoard {
  const plan = game.rounds[round] as SortGame['rounds'][number];
  const queues: SortItem[][] = Array.from({ length: plan.queues }, () => []);
  const buffer: SortItem[] = [];
  const binned = new Array<number>(SORT.kinds).fill(0);
  for (let item = plan.start; item < plan.start + plan.count; item += 1) {
    const base = bodyBase(item);
    const kind = bodyHp(state, item) - 1;
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) binned[kind] = (binned[kind] as number) + 1;
    else if (targetStateOf(state, item) === SORT_BUFFERED) buffer.push({ body: item, kind });
    else (queues[queueOfX(state[base + BODY.x] as number, plan.queues)] as SortItem[]).push({ body: item, kind });
  }
  return { queues, buffer, binned, bins: binsOf(plan), show: plan.show, capacity: game.capacity, slots: game.slots };
}

/** Rozestaví věci kola: fronty od první řady (čelo vpředu), odkladiště po místech v pořadí těl. */
export function layoutRound(state: Int32Array, game: SortGame, round: number): void {
  const plan = game.rounds[round] as SortGame['rounds'][number];
  const depth = new Array<number>(plan.queues).fill(0);
  let held = 0;
  for (let item = plan.start; item < plan.start + plan.count; item += 1) {
    const base = bodyBase(item);
    if (((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    if (targetStateOf(state, item) === SORT_BUFFERED) {
      state[base + BODY.x] = slotX(held, game.slots);
      state[base + BODY.z] = SORT_LAYOUT.bufferZ;
      held += 1;
      continue;
    }
    const queue = queueOfX(state[base + BODY.x] as number, plan.queues);
    state[base + BODY.z] = rowZ(depth[queue] as number);
    depth[queue] = (depth[queue] as number) + 1;
  }
}

// ---------------------------------------------------------------------------
// Ovládání

/** Rychlost hrdiny mezi sloupci (j/tik), jako pruhy. */
const HERO_SPEED = LANES.speed;

/**
 * Ovládání třídění: pruh jako ovládání pruhů (osa ťuku, šipky o sloupec, mezerník ťuk v pruhu hrdiny), jen sevřený
 * na pruhy front běžícího kola; hrdina za frontami dojde ke zvolenému sloupci. K tomu hodiny kola a rozestavení věcí.
 */
export const sortControl: ControlPiece<SortGame> = {
  id: 'sort',
  params: sortGameSchema,
  roles: ['player', 'collectible'],
  cost: () => ({ bodies: 0, rules: 0 }),
  step: (state, player, input, game) => {
    const round = roundIn(state, game);
    const plan = game.rounds[round] as SortGame['rounds'][number];
    const first = firstLane(plan.queues);
    const last = first + plan.queues - 1;
    const clamp = (lane: number): number => Math.min(last, Math.max(first, lane));
    const base = bodyBase(player);
    let lane = clamp(laneOf(state, player));
    if (input.axis !== 0) lane = clamp(laneOfAxis(input.axis));
    if ((input.buttons & BUTTON.LEFT) !== 0) lane = clamp(lane - 1);
    if ((input.buttons & BUTTON.RIGHT) !== 0) lane = clamp(lane + 1);
    state[base + BODY.aux0] = lane - LANE_START;
    const dx = queueX(lane - first, plan.queues) - (state[base + BODY.x] as number);
    state[base + BODY.vx] = Math.max(-HERO_SPEED, Math.min(HERO_SPEED, dx));
    const held = state[base + BODY.aux1] as number;
    const tap = (input.buttons & BUTTON.TAP) !== 0;
    state[base + BODY.aux1] = tap ? -1 : (input.buttons & BUTTON.HOLD) !== 0 ? Math.max(0, held) + 1 : 0;
    const board = bodyBase(game.board);
    if (state[board + BODY.y] !== round) {
      state[board + BODY.y] = round;
      state[board + BODY.x] = 0;
    }
    state[board + BODY.x] = (state[board + BODY.x] as number) + 1;
    if (tap) state[board + BODY.z] = state[HEADER.tick] as number;
    layoutRound(state, game, round);
  },
};

// ---------------------------------------------------------------------------
// Pravidlo

const tapParams = z
  .object({
    ...gameShape,
    points: z.int().min(1).max(100),
    /** Okno série (tiky, `nextMultiplier`). */
    window: z.int().min(1).max(ARCADE_LIMITS.maxTicks),
    /** Počítadlo komba (`withCombo`); bez něj body bez násobiče. */
    combo: body.optional(),
  })
  .strict();
export type SortTapParams = z.infer<typeof tapParams>;

/** Násobič věci poslané rovnou: po shozené sérii (násobič 0) znovu od ×1, jinak o stupeň výš v okně série. */
const streak = (state: Int32Array, combo: number, window: number): number => ((state[bodyBase(combo) + BODY.aux0] as number) === 0 ? 1 : nextMultiplier(state, combo, window));

/**
 * Třídění (tik): po hodinách kola prohra; ťuk do sloupce fronty pošle čelo (`tapQueue`) – do nádoby body, kombo
 * a čítač `items`, do odkladiště stav `SORT_BUFFERED` a shozená série; plné odkladiště prohra, hotové kolo výhra.
 */
export const sortTapRule: RulePiece<SortTapParams> = {
  id: 'sort_tap',
  params: tapParams,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    if ((state[bodyBase(params.board) + BODY.x] as number) >= params.ticks) return [{ kind: 'lose' }];
    const lane = tappedIn(state, player);
    if (lane === null) return [];
    const round = roundIn(state, params);
    const plan = params.rounds[round] as SortGame['rounds'][number];
    const queue = lane - firstLane(plan.queues);
    if (queue < 0 || queue >= plan.queues) return [];
    const tap = tapQueue(boardOfState(state, params, round), queue);
    const effects: ArcadeEffect[] = [];
    for (const move of tap.moves) {
      if (move.to === 'buffer') {
        effects.push({ kind: 'stateChange', body: move.body, state: SORT_BUFFERED });
        if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier: 0 });
        continue;
      }
      const multiplier = move.tapped && params.combo !== undefined ? streak(state, params.combo, params.window) : 1;
      // `score` a hned `despawn` sbírané věci = sebrání pro vzácnost háčků (`collectedAt`).
      effects.push({ kind: 'score', amount: params.points * multiplier }, { kind: 'despawn', body: move.body }, { kind: 'count', counter: 'items', amount: 1 });
      if (move.tapped && params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    }
    if (tap.outcome !== null) effects.push({ kind: tap.outcome });
    return effects;
  },
};

export const SORT_RULES: Readonly<Record<string, RulePiece>> = { sort_tap: sortTapRule as RulePiece };

// ---------------------------------------------------------------------------
// Generátor

export const sortParams = z
  .object({
    /** Věcí za hru (`COUNT_PARAMS.sort.default.collectible`). */
    items: z.int().min(SORT.items.min).max(SORT.items.max).default(SORT.items.default),
    rounds: z.int().min(SORT.rounds.min).max(SORT.rounds.max).default(SORT.rounds.default),
  })
  .strict();
export type SortParams = z.infer<typeof sortParams>;

/** Tempo robota světa (tiky mezi ťuky): hráč si čelo prohlédne, než klepne – hra s robotem trvá 30–70 s. */
export const SORT_BOT_PACE = 55;

/** Věc kola `round` ve frontě `queue` na místě `order` (čelo 0); věci pozdějších kol čekají za scénou. */
function itemBody(kind: number, queue: number, queues: number, order: number, round: number): BodyInit {
  const { item } = SORT_LAYOUT;
  return { role: 'collectible', kind: 'sort-item', x: queueX(queue, queues), y: 0, z: round === 0 ? rowZ(order) : SORT_LAYOUT.waitZ + round * 4 * item, w: item, h: item, d: item, solid: false, hp: kind + 1 };
}

/** Tvrzení o hotové úrovni: každé kolo má věci přesně na své nádoby a svět se vejde do mezí jádra. */
export function checkSortLevel(level: ArcadeLevel, rounds: readonly SortRound[], game: SortGame): string[] {
  const issues: string[] = [];
  rounds.forEach((round, index) => {
    const plan = game.rounds[index] as SortGame['rounds'][number];
    const kinds = new Array<number>(SORT.kinds).fill(0);
    for (let item = plan.start; item < plan.start + plan.count; item += 1) {
      const kind = (level.bodies[item]?.hp ?? 0) - 1;
      if (kind < 0 || kind >= SORT.kinds) issues.push(`round ${index + 1}: item ${item} has no kind`);
      else kinds[kind] = (kinds[kind] as number) + 1;
    }
    const wanted = new Array<number>(SORT.kinds).fill(0);
    for (const kind of round.bins) wanted[kind] = (wanted[kind] as number) + game.capacity;
    if (kinds.join() !== wanted.join()) issues.push(`round ${index + 1}: items ${kinds.join('/')} do not fill bins ${wanted.join('/')}`);
    if (round.queues.some((line) => line.length === 0)) issues.push(`round ${index + 1}: a queue is empty`);
  });
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/**
 * Díly světa: hrdina za frontami, věci všech kol (kolo po kole, fronta po frontě, čelo první), počítadlo třídění,
 * pravidlo `sort_tap`, pilulka postupu HUD (`finish_collected` – tělo cíle svět nemá, takže nevystřelí) a háčky
 * (kola, vzácnost věcí). Životy třídění nemá: prohra je plné odkladiště nebo hodiny kola.
 */
export function sortParts(seed: number, params: SortParams): ModeParts {
  return sortPartsOf(seed, sortRounds(seed, params.items, params.rounds));
}

/** Díly světa z hotových kol (generátor, ruční kola testů); `slots` = místa odkladiště. */
export function sortPartsOf(seed: number, rounds: readonly SortRound[], slots: number = SORT.slots): ModeParts {
  const hero: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: SORT_LAYOUT.heroZ, ...SORT_LAYOUT.hero, solid: false };
  const bodies: BodyInit[] = [hero];
  const plans: SortGame['rounds'][number][] = rounds.map((round, index) => {
    const start = bodies.length;
    round.queues.forEach((line, queue) => line.forEach((kind, order) => bodies.push(itemBody(kind, queue, round.queues.length, order, index))));
    return { start, count: bodies.length - start, bins: round.bins.join(''), show: round.show, queues: round.queues.length };
  });
  const board = bodies.length;
  bodies.push({ role: 'thing', kind: 'player', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true });
  const keeper = bodies.length;
  const game: SortGame = { board, keeper, slots, capacity: SORT.capacity, ticks: SORT.roundSeconds * ARCADE_HZ, rounds: plans };
  const total = plans.reduce((sum, plan) => sum + plan.count, 0);
  const level: ArcadeLevel = { bodies, length: 0 };
  const rules: PieceRef[] = [
    { id: 'sort_tap', params: { ...game, points: SORT.points, window: SORT.comboWindow } },
    { id: 'finish_collected', params: { need: total } },
  ];
  const bot: PieceRef = { id: 'sort_bot', params: { ...game, pace: SORT_BOT_PACE, mistakes: 0 } };
  const hooked = withHooks({ level, rules, bot }, seed, { rounds: rounds.length, clear: 'win', rarity: true });
  const issues = hooked.keeper === keeper ? checkSortLevel(level, rounds, game) : [`sort: the hooks counter landed at ${hooked.keeper}, not ${keeper}`];
  return { control: { id: 'sort', params: game }, bot: hooked.bot, level: hooked.level, rules: hooked.rules, issues };
}

export const sortBins: ModeGeneratorPiece<SortParams> = {
  id: 'sort_bins',
  params: sortParams,
  roles: ['player', 'collectible'],
  cost: (params) => ({ bodies: 3 + binsPerRound(params.items, params.rounds).reduce((sum, bins) => sum + bins, 0) * SORT.capacity, rules: 3 }),
  generate: (seed, params) => sortParts(seed, params).level,
  parts: (seed, params) => sortParts(seed, params),
};
