/**
 * Krádež (P66 T7): hráč joystickem doběhne k cizí základně, popadne kořist z věty, s nákladem pomaleji ji odnese na
 * svou základnu; strážci (nepřítel z věty) hlídají cestu, honí ho a při dotyku kořist vezmou zpět. Kola „Round N of
 * M“, mezi nimi výběr 1 ze 3 vylepšení a vzácnost kořisti jsou háčky `arcade/hooks` (`withHooks`, `clear: 'win'`).
 *
 * **Hřiště na výšku:** úzký pás `2 × half` napříč a `2 × length` podél osy z. Domovská základna leží dole (−z, u
 * kamery), cizí nahoře (+z); cesta vede po výšce obrazovky. Hráč startuje doma.
 *
 * **Kolo** (`roundOf` háčků): na cizí základně leží `perRound` kusů kořisti, kolo vyhraje `perRound` odnesených
 * (čítač `items`, pilulka postupu přes `finish_collected` – bez těla cíle nevystřelí). Každé další kolo přidá
 * strážce; poslední kolo má velkou kořist (finále, vždy epická) a silnějšího strážce, který ji hlídá. Kolo má vlastní
 * hodiny (`roundTicksOf`): doběhnou = prohra. Životy na nule = prohra.
 *
 * **Stav:**
 * - kořist nese v bitech stavu cíle `0` = leží (na místě nebo kde ji magnet nechal), `1` = nese ji hrdina,
 *   `2` = upuštěná (strážce ji vzal), ovládání ji další tik vrátí na její místo;
 * - strážce nese v `aux0` honičku (bit 0) a směr hlídky (bit 1 = −x); `aux1` zůstává 0 (jádro v něm čte kyvadlo);
 * - počítadlo krádeže (`keeper`, mrtvá předloha za tělesy úrovně) nese v `x` kolo, které je postavené, a v `y` tik
 *   jeho začátku. Tělesa dalších kol leží v úrovni mrtvá a ovládání je na začátku kola oživí.
 *
 * **Pravidla:** `steal_grab` (dotyk: kořist → nesená, do kapacity `1 + carry`), `steal_home` (tik: hrdina doma
 * odevzdá nesenou kořist – dvojice `score` + `despawn`, z níž háčky čtou vzácnost; s `combo` zvedá kombo),
 * `steal_tag` (dotyk strážce: život s milostí, hrdina domů, nesená kořist upuštěná), `steal_clock` (hodiny kola
 * a vstup velkého strážce na začátku posledního kola). Pravidla leží u ovládání a generátoru jako u `push-ring.ts`.
 *
 * Determinismus: náhoda jen při stavbě (`roundSeeds` háčků → `createCompileRng` kola), za běhu celá čísla bez
 * náhody, čas v tikách.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeState,
  BODY,
  type BodyInit,
  COMBO,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  RESTITUTION_SHIFT,
  ROLE,
  type RulePiece,
  START_LIVES,
  UNIT,
  bodyBase,
  graceOf,
  setTargetState,
  targetStateOf,
} from '../contract';
import { roundOf, roundSeeds, upgradeLevel, withHooks } from '../hooks';
import { RARITY, ROUNDS, UPGRADE_OFFER, type UpgradeId } from '../hooks/contract';
import { DIRECTIONS, directionOfAxis } from './arena';
import { nextMultiplier } from './rules';

export const STEAL = {
  /** Polovina šířky hřiště (x) a polovina délky (z), j. */
  half: 3800,
  length: 9500,
  /** Domovská základna (dole) a cizí základna (nahoře): střed z a poloviny rozměrů. */
  home: { z: -7800, halfW: 2600, halfD: 1500 },
  base: { z: 7300, halfW: 3000, halfD: 1700 },
  /** Kde hrdina startuje a kam se po chycení vrací. */
  start: -8000,
  hero: { w: 900, h: 1200 },
  /** Hrdina: rychlost (9 m/s), rozjezd a brzda za tik. */
  speed: 150,
  accel: 25,
  friction: 30,
  /** S nákladem jede hrdina na `pct` % rychlosti; každý stupeň `carry` přidá `step` % a jednu nesenou věc navíc. */
  carry: { pct: 72, step: 8 },
  loot: { w: 700, h: 700, points: 100 },
  /** Velká kořist finále: větší, víc bodů, vždy epická. */
  big: { w: 1200, h: 1100, points: 400 },
  /**
   * Strážce hlídá cizí základnu: chodí napříč po své řadě (`patrol` j/tik, nejdál `range` od středu). Hrdinu, který
   * se v základně (a `alert` pod ní) přiblíží na `sight`, honí rychlostí `chase` + `step` za kolo – těsně pod hrdinou
   * s nákladem: chytí toho, kdo mu vběhne do cesty nebo zabrzdí, ne toho, kdo už utíká. Hrdinu bez nákladu pustí,
   * jakmile vyjde `drop` pod základnu; zloděje
   * s kořistí honí až k `leash` – pod ní je cesta domů bezpečná. Rozjezd nejvýš `accel` za tik a osu, předvídání
   * nejvýš `lead` tiků.
   */
  guard: { w: 1100, h: 1500, patrol: 36, chase: 108, step: 2, sight: 2600, alert: 400, keep: 6000, accel: 8, lead: 15, leash: -3500, range: 2700 },
  /** Strážce velké kořisti v posledním kole: větší, rychlejší, vidí dál; hlídá řadu těsně za ní. */
  boss: { w: 1500, h: 1900, patrol: 28, chase: 112, sight: 3000, z: 7000, range: 2700 },
  /**
   * Řady hlídky strážců (z) za kořistí, v pořadí, jak strážci přibývají (třetí jde zase do první řady, na opačnou
   * stranu). Kořist leží vpředu u vstupu do základny (`stash`): zloděj ji sebere a strážci za ní ho honí cestou domů.
   */
  rows: [7300, 8500] as readonly number[],
  /** Kořist kol leží v přední části základny (z). */
  stash: { from: 5900, to: 6500 },
  /** Milost po chycení (tiky). */
  grace: 60,
  /** Kola (háčky `ROUNDS`), kořist na kolo a strážci prvního kola. */
  rounds: { min: 2, max: 4, default: 3 },
  perRound: { min: 2, max: 4, default: 3 },
  guards: { min: 1, max: 3, default: 1 },
  /** Hodiny kola nejvýš (s). */
  roundSeconds: 30,
} as const;

/** Vylepšení, která krádež nabízí (AC T7): rychlost, náklad, život, magnet na kořist. */
export const STEAL_UPGRADES: readonly UpgradeId[] = ['speed', 'carry', 'extra_life', 'magnet'];

/**
 * Hodiny jednoho kola (tiky): všechna kola i přestávky robota (volba karty za `breakTicks` / 3) se vejdou do
 * horizontu ověření, nejvýš `roundSeconds`. Hráč, který na kartu čeká celých `pickTicks`, hraje déle než horizont –
 * jeho běh doběhne, jen výzvu (přehrání do horizontu) z něj server nepostaví.
 */
export const roundTicksOf = (rounds: number): number =>
  Math.min(STEAL.roundSeconds * ARCADE_HZ, Math.floor((ARCADE_LIMITS.maxTicks - (rounds - 1) * Math.ceil(ROUNDS.breakTicks / 3) - ARCADE_HZ) / rounds));

/** Stavy kořisti v bitech stavu cíle. */
export const LOOT = { free: 0, carried: 1, dropped: 2 } as const;

/** Sloty počítadla krádeže: kolo, které je postavené, a tik jeho začátku. */
export const STEAL_SLOTS = { round: BODY.x, start: BODY.y } as const;

const GUARD_CHASE = 1;
const GUARD_WEST = 2;

// ---------------------------------------------------------------------------
// Čtení stavu (sdílí ho ovládání, pravidla, robot i scéna)

const alive = (state: ArrayLike<number>, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const slot = (state: ArrayLike<number>, body: number, at: number): number => state[bodyBase(body) + at] as number;
/** Celočíselná délka vektoru (`Math.sqrt` je v IEEE 754 přesně zaokrouhlená – všude stejné číslo). */
export const length = (dx: number, dz: number): number => Math.floor(Math.sqrt(dx * dx + dz * dz));
const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

/** Leží bod v domovské základně? */
export const atHome = (x: number, z: number): boolean => Math.abs(x) <= STEAL.home.halfW && Math.abs(z - STEAL.home.z) <= STEAL.home.halfD;

/** Kořist ve světě: živé sbírané těleso. */
export const isLoot = (state: ArrayLike<number>, body: number): boolean => alive(state, body) && slot(state, body, BODY.role) === ROLE.collectible;
export const lootState = (state: Int32Array, body: number): number => targetStateOf(state, body);

/** Živá kořist ve stavu `which` vzestupně. */
export function lootIn(state: Int32Array, which: number): number[] {
  const out: number[] = [];
  for (let body = 1; body < (state[HEADER.bodyCount] as number); body += 1) if (isLoot(state, body) && targetStateOf(state, body) === which) out.push(body);
  return out;
}

/** Živí strážci vzestupně. */
export function guardsOf(state: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let body = 1; body < (state[HEADER.bodyCount] as number); body += 1) if (alive(state, body) && slot(state, body, BODY.role) === ROLE.chaser) out.push(body);
  return out;
}

/** Honí strážce právě hrdinu? */
export const chasing = (state: ArrayLike<number>, guard: number): boolean => (slot(state, guard, BODY.aux0) & GUARD_CHASE) !== 0;

/** Kolik věcí hrdina unese naráz: 1 + stupeň `carry`. */
export const capacityOf = (state: Int32Array, hooks: number): number => 1 + upgradeLevel(state, hooks, 'carry');

/** Rychlost hrdiny (j/tik): s nákladem `carry.pct` %, každý stupeň `carry` o `carry.step` % víc. */
export function heroSpeedOf(state: Int32Array, hooks: number, carrying: boolean): number {
  if (!carrying) return STEAL.speed;
  return Math.trunc((STEAL.speed * Math.min(100, STEAL.carry.pct + STEAL.carry.step * upgradeLevel(state, hooks, 'carry'))) / 100);
}

/** Kolo, které je ve světě postavené, a tik jeho začátku (počítadlo krádeže). */
export const builtRound = (state: ArrayLike<number>, keeper: number): number => slot(state, keeper, STEAL_SLOTS.round);
export const roundStartOf = (state: ArrayLike<number>, keeper: number): number => slot(state, keeper, STEAL_SLOTS.start);

// ---------------------------------------------------------------------------
// Parametry, které generátor předá ovládání, pravidlům a robotovi

const body = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const coord = z.int().min(-20 * UNIT).max(20 * UNIT);

const postSchema = z
  .object({
    x: coord,
    z: coord,
    /** Polovina rozsahu hlídky napříč. */
    range: z.int().min(0).max(STEAL.half),
    /** Od kterého kola (0..) hlídá. */
    from: z.int().min(0).max(ROUNDS.max - 1),
    /** Strážce velké kořisti (poslední kolo). */
    boss: z.literal(true).optional(),
  })
  .strict();
export type GuardPost = z.infer<typeof postSchema>;

const controlParams = z
  .object({
    keeper: body,
    hooks: body,
    rounds: z.int().min(STEAL.rounds.min).max(STEAL.rounds.max),
    /** Kořist: první tělo, kusů na kolo, místo každého kusu (v pořadí těl). */
    loot: z.object({ first: body, per: z.int().min(STEAL.perRound.min).max(STEAL.perRound.max), spots: z.array(z.tuple([coord, coord])).min(2).max(ROUNDS.max * STEAL.perRound.max) }).strict(),
    /** Strážci: první tělo a stanoviště každého (v pořadí těl). */
    guards: z.object({ first: body, posts: z.array(postSchema).min(1).max(12) }).strict(),
  })
  .strict();
export type StealControlParams = z.infer<typeof controlParams>;

// ---------------------------------------------------------------------------
// Ovládání

/**
 * Začátek kola `round` (první tik po přestávce): kolo a tik do počítadla, `items` na nulu, hrdina domů, kořist kola
 * na svých místech, strážci kola na stanovištích. Kořist minulých kol (odevzdaná) zůstává mrtvá. Velká kořist
 * posledního kola je epická vždy – dostane kód vzácnosti dřív, než háčky losují.
 */
function setupRound(state: ArcadeState, player: number, params: StealControlParams, round: number): void {
  const keeper = bodyBase(params.keeper);
  state[keeper + STEAL_SLOTS.round] = round;
  state[keeper + STEAL_SLOTS.start] = state[HEADER.tick] as number;
  state[HEADER.counters + COUNTER.items] = 0;
  const p = bodyBase(player);
  state[p + BODY.x] = state[HEADER.respawnX] as number;
  state[p + BODY.z] = state[HEADER.respawnZ] as number;
  state[p + BODY.vx] = 0;
  state[p + BODY.vz] = 0;
  const last = round === params.rounds - 1;
  params.loot.spots.forEach(([x, z], k) => {
    const loot = params.loot.first + k;
    const base = bodyBase(loot);
    const mine = Math.floor(k / params.loot.per) === round;
    if (!mine) {
      state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
      return;
    }
    state[base + BODY.x] = x;
    state[base + BODY.y] = 0;
    state[base + BODY.z] = z;
    state[base + BODY.vx] = 0;
    state[base + BODY.vy] = 0;
    state[base + BODY.vz] = 0;
    state[base + BODY.flags] = (state[base + BODY.flags] as number) | FLAG.alive;
    setTargetState(state, loot, LOOT.free);
    if (last && k % params.loot.per === 0) state[base + BODY.flags] = (state[base + BODY.flags] as number) | ((RARITY.indexOf('epic') + 1) << RESTITUTION_SHIFT);
  });
  params.guards.posts.forEach((post, k) => {
    const base = bodyBase(params.guards.first + k);
    const on = post.from <= round && (post.boss !== true || last);
    state[base + BODY.flags] = on ? (state[base + BODY.flags] as number) | FLAG.alive : (state[base + BODY.flags] as number) & ~FLAG.alive;
    state[base + BODY.x] = post.x;
    state[base + BODY.z] = post.z;
    state[base + BODY.vx] = 0;
    state[base + BODY.vz] = 0;
    state[base + BODY.aux0] = 0;
  });
}

/** Hrdina: osa = směr z 32, rozjezd k rychlosti (s nákladem pomalejší), bez osy brzda; hřiště ho drží uvnitř. */
function moveHero(state: ArcadeState, player: number, axis: number, speed: number): void {
  const p = bodyBase(player);
  const direction = directionOfAxis(axis);
  const dir = direction < 0 ? null : (DIRECTIONS[direction] as { dx: number; dz: number });
  const tx = dir === null ? 0 : Math.trunc((dir.dx * speed) / 1000);
  const tz = dir === null ? 0 : Math.trunc((dir.dz * speed) / 1000);
  const rate = dir === null ? STEAL.friction : STEAL.accel;
  const limitX = STEAL.half - STEAL.hero.w / 2;
  const limitZ = STEAL.length - STEAL.hero.w / 2;
  // Vylepšení `speed` (háčky) hrdinu posune navíc ještě před ovládáním: hranu hřiště drží i poloha.
  const x = Math.max(-limitX, Math.min(limitX, state[p + BODY.x] as number));
  const zz = Math.max(-limitZ, Math.min(limitZ, state[p + BODY.z] as number));
  state[p + BODY.x] = x;
  state[p + BODY.z] = zz;
  const vx = toward(state[p + BODY.vx] as number, tx, rate);
  const vz = toward(state[p + BODY.vz] as number, tz, rate);
  state[p + BODY.vx] = Math.max(-limitX - x, Math.min(limitX - x, vx));
  state[p + BODY.vz] = Math.max(-limitZ - zz, Math.min(limitZ - zz, vz));
}

/** Nesená kořist sedí hrdinovi nad hlavou (kde bude po tomhle tiku), upuštěná se vrátí na své místo. */
function moveLoot(state: ArcadeState, player: number, params: StealControlParams, capacity: number): void {
  const p = bodyBase(player);
  const hx = (state[p + BODY.x] as number) + (state[p + BODY.vx] as number);
  const hz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number);
  let stack = state[p + BODY.h] as number;
  let carried = 0;
  params.loot.spots.forEach(([x, z], k) => {
    const loot = params.loot.first + k;
    if (!isLoot(state, loot)) return;
    const base = bodyBase(loot);
    let held = targetStateOf(state, loot);
    // Dvě věci téhož tiku nad kapacitu: ta navíc se vrátí.
    if (held === LOOT.carried && carried >= capacity) held = LOOT.dropped;
    if (held === LOOT.carried) {
      carried += 1;
      state[base + BODY.x] = hx;
      state[base + BODY.y] = stack;
      state[base + BODY.z] = hz;
      stack += state[base + BODY.h] as number;
    } else if (held === LOOT.dropped) {
      state[base + BODY.x] = x;
      state[base + BODY.y] = 0;
      state[base + BODY.z] = z;
      setTargetState(state, loot, LOOT.free);
    }
  });
}

/** Rychlost honičky strážce v kole `round`. */
const chaseOf = (post: GuardPost, round: number): number => (post.boss === true ? STEAL.boss.chase : STEAL.guard.chase + STEAL.guard.step * round);

/** Spodní okraj cizí základny (z). */
export const BASE_EDGE = STEAL.base.z - STEAL.base.halfD;

/**
 * Honí strážce hrdinu v `px, pz` (`chasing` = honil minulý tik, `carrying` = hrdina nese kořist)? Honí jen zloděje:
 * začne, když hrdina s kořistí je v základně (nebo `alert` pod ní) blíž než dohled, a honí, dokud je blíž než `keep`
 * a výš než `leash`. Hrdinu bez kořisti nehoní – jen do něj při hlídce narazí. Robot se ptá tudy taky.
 */
export function huntsAt(pz: number, gap: number, sight: number, chasing: boolean, carrying: boolean): boolean {
  if (!carrying) return false;
  if (!chasing) return pz >= BASE_EDGE - STEAL.guard.alert && gap < sight;
  return gap < STEAL.guard.keep && pz > STEAL.guard.leash;
}

/**
 * Strážci: hlídka napříč po své řadě v cizí základně; hrdinu, kterého zahlédnou (`huntsAt`), honí (míří, kam hrdina
 * dojde, nejvýš `lead` tiků dopředu), hrdinu v milosti po chycení ani doma ne. Rychlost mění nejvýš o `accel` za tik
 * a osu; z hřiště ani pod `leash` nevyjdou.
 */
function steerGuards(state: ArcadeState, player: number, params: StealControlParams, round: number): void {
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = state[p + BODY.z] as number;
  const safe = graceOf(state, player) > 0 || atHome(px, pz);
  const carrying = lootIn(state, LOOT.carried).length > 0;
  params.guards.posts.forEach((post, k) => {
    const guard = params.guards.first + k;
    if (!alive(state, guard)) return;
    const base = bodyBase(guard);
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    const vx = state[base + BODY.vx] as number;
    const vz = state[base + BODY.vz] as number;
    const mode = state[base + BODY.aux0] as number;
    const boss = post.boss === true;
    const gap = length(px - x, pz - zz);
    const hunting = !safe && huntsAt(pz, gap, boss ? STEAL.boss.sight : STEAL.guard.sight, (mode & GUARD_CHASE) !== 0, carrying);
    const w = state[base + BODY.w] as number;
    const limitX = STEAL.half - Math.ceil(w / 2);
    // Hlídka chodí kolem středu hřiště, nejdál `range` (a nejdál ke stěně); start ze semínka je jen místo na začátku kola.
    const reach = Math.min(post.range, limitX);
    let west = (mode & GUARD_WEST) !== 0;
    let tx: number;
    let tz: number;
    if (hunting) {
      const speed = chaseOf(post, round);
      const ahead = Math.min(STEAL.guard.lead, Math.floor(gap / speed));
      const wx = px + (state[p + BODY.vx] as number) * ahead - x;
      const wz = pz + (state[p + BODY.vz] as number) * ahead - zz;
      const aim = Math.max(1, length(wx, wz));
      tx = Math.trunc((wx * speed) / aim);
      tz = Math.trunc((wz * speed) / aim);
    } else {
      if (x >= reach) west = true;
      else if (x <= -reach) west = false;
      // Mimo řadu (po honičce) zpět k ní, rychlostí návratu; na řadě hlídka napříč.
      const back = post.z - zz;
      const patrol = boss ? STEAL.boss.patrol : STEAL.guard.patrol;
      const returning = Math.abs(back) > patrol;
      tx = returning ? 0 : west ? -patrol : patrol;
      // Úměrně vzdálenosti (osmina za tik), ať řadu nepřejede a nekmitá kolem ní.
      tz = Math.max(-STEAL.guard.chase, Math.min(STEAL.guard.chase, Math.trunc(back / 8)));
    }
    let nvx = toward(vx, tx, STEAL.guard.accel);
    let nvz = toward(vz, tz, STEAL.guard.accel);
    const top = STEAL.length - Math.ceil(w / 2);
    nvx = Math.max(-limitX - x, Math.min(limitX - x, nvx));
    nvz = Math.max(STEAL.guard.leash - zz, Math.min(top - zz, nvz));
    state[base + BODY.vx] = nvx;
    state[base + BODY.vz] = nvz;
    state[base + BODY.aux0] = (hunting ? GUARD_CHASE : 0) | (west ? GUARD_WEST : 0);
  });
}

export const stealControl: ControlPiece<StealControlParams> = {
  id: 'steal',
  params: controlParams,
  roles: ['player', 'collectible', 'chaser'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const round = roundOf(state, params.hooks);
    if (round !== builtRound(state, params.keeper)) setupRound(state, player, params, round);
    const capacity = capacityOf(state, params.hooks);
    moveHero(state, player, input.axis, heroSpeedOf(state, params.hooks, lootIn(state, LOOT.carried).length > 0));
    moveLoot(state, player, params, capacity);
    steerGuards(state, player, params, round);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const grabParams = z.object({ hooks: body }).strict();

/** Dotyk kořisti, která leží: hrdina ji vezme, má-li volné místo a není v milosti po chycení. */
export const stealGrab: RulePiece<z.infer<typeof grabParams>> = {
  id: 'steal_grab',
  params: grabParams,
  roles: ['player', 'collectible'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params) => {
    if (!isLoot(state, other) || targetStateOf(state, other) !== LOOT.free || graceOf(state, player) > 0) return [];
    if (lootIn(state, LOOT.carried).length >= capacityOf(state, params.hooks)) return [];
    return [{ kind: 'stateChange', body: other, state: LOOT.carried }];
  },
};

const homeParams = z
  .object({
    /** Kořisti na kolo: tolik odnesených kolo vyhraje. */
    need: z.int().min(STEAL.perRound.min).max(STEAL.perRound.max),
    points: z.int().min(1).max(10_000),
    /** Velká kořist finále a její body. */
    big: body,
    bigPoints: z.int().min(1).max(10_000),
    /** Počítadlo komba (`withCombo` ho doplní hře `genre.v6`, `hookedComboSources`). */
    combo: body.optional(),
  })
  .strict();

/**
 * Hrdina doma odevzdá všechno, co nese: za každý kus kombo (s `combo`), body a zmizení – dvojice `score` + `despawn`,
 * ze které háčky čtou vzácnost – a `items` + 1. Kolik je odneseno, tolik kolo vyhraje.
 */
export const stealHome: RulePiece<z.infer<typeof homeParams>> = {
  id: 'steal_home',
  params: homeParams,
  roles: ['player', 'collectible'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const p = bodyBase(player);
    if (!atHome(state[p + BODY.x] as number, state[p + BODY.z] as number)) return [];
    const carried = lootIn(state, LOOT.carried);
    if (carried.length === 0) return [];
    const out: ArcadeEffect[] = [];
    let multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo) - 1;
    for (const loot of carried) {
      if (params.combo !== undefined) {
        multiplier = Math.min(COMBO.max, multiplier + 1);
        out.push({ kind: 'combo', body: params.combo, multiplier });
      }
      out.push({ kind: 'score', amount: (loot === params.big ? params.bigPoints : params.points) * multiplier }, { kind: 'despawn', body: loot });
    }
    out.push({ kind: 'count', counter: 'items', amount: carried.length });
    if ((state[HEADER.counters + COUNTER.items] as number) + carried.length >= params.need) out.push({ kind: 'win' });
    return out;
  },
};

const tagParams = z.object({}).strict();

/** Strážce hrdinu chytí: život s milostí, hrdina zpět domů, nesená kořist upuštěná (vrátí se na své místo). */
export const stealTag: RulePiece<z.infer<typeof tagParams>> = {
  id: 'steal_tag',
  params: tagParams,
  roles: ['player', 'chaser'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }) => {
    if (!alive(state, other) || state[bodyBase(other) + BODY.role] !== ROLE.chaser || graceOf(state, player) > 0) return [];
    return [
      { kind: 'damage', amount: 1, grace: STEAL.grace },
      { kind: 'respawn' },
      ...lootIn(state, LOOT.carried).map((loot): ArcadeEffect => ({ kind: 'stateChange', body: loot, state: LOOT.dropped })),
    ];
  },
};

const clockParams = z
  .object({
    keeper: body,
    ticks: z.int().min(10 * ARCADE_HZ).max(ARCADE_LIMITS.maxTicks),
    /** Poslední kolo (0..) a strážce velké kořisti: jeho vstup ohlásí moment bosse háčků. */
    last: z.int().min(1).max(ROUNDS.max - 1),
    boss: body,
  })
  .strict();

/** Hodiny kola: doběhnou = prohra. Na začátku posledního kola vstoupí strážce velké kořisti (`boss_enter`, „Boss!“). */
export const stealClock: RulePiece<z.infer<typeof clockParams>> = {
  id: 'steal_clock',
  params: clockParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const tick = state[HEADER.tick] as number;
    const start = roundStartOf(state, params.keeper);
    if (tick - start >= params.ticks) return [{ kind: 'lose' }];
    if (tick === start && builtRound(state, params.keeper) === params.last && alive(state, params.boss)) return [{ kind: 'boss_enter', body: params.boss }, { kind: 'callout', callout: 'boss' }];
    return [];
  },
};

export const STEAL_RULES: Readonly<Record<string, RulePiece>> = {
  steal_grab: stealGrab as RulePiece,
  steal_home: stealHome as RulePiece,
  steal_tag: stealTag as RulePiece,
  steal_clock: stealClock as RulePiece,
};

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    rounds: z.int().min(STEAL.rounds.min).max(STEAL.rounds.max).default(STEAL.rounds.default),
    loot: z.int().min(STEAL.perRound.min).max(STEAL.perRound.max).default(STEAL.perRound.default),
    guards: z.int().min(STEAL.guards.min).max(STEAL.guards.max).default(STEAL.guards.default),
  })
  .strict();
export type StealParams = z.infer<typeof generatorParams>;

/** Rozvržení kola: místa kořisti na cizí základně a stanoviště nových strážců. */
interface RoundLayout {
  readonly spots: readonly (readonly [number, number])[];
  readonly posts: readonly GuardPost[];
}

/**
 * Kolo `round` ze semínka kola (`roundSeeds`): kořist rozložená po šířce cizí základny (v posledním kole první kus
 * velký uprostřed vzadu), noví strážci na dalších řadách hlídky (`rows`). Poslední kolo místo obyčejného strážce
 * přidá strážce velké kořisti (`stealParts`).
 */
function layoutRound(seed: number, round: number, params: StealParams, firstGuard: number): RoundLayout {
  const rng = createCompileRng(seed, 'layout');
  const last = round === params.rounds - 1;
  const spots: (readonly [number, number])[] = [];
  const lane = (2 * (STEAL.base.halfW - STEAL.loot.w)) / params.loot;
  for (let k = 0; k < params.loot; k += 1) {
    if (last && k === 0) {
      spots.push([0, STEAL.stash.to - Math.trunc(STEAL.big.w / 4)]);
      continue;
    }
    const x0 = -(STEAL.base.halfW - STEAL.loot.w) + Math.round(lane * k);
    spots.push([x0 + rng.int(0, Math.max(0, Math.round(lane) - STEAL.loot.w)), rng.int(STEAL.stash.from, STEAL.stash.to)]);
  }
  // Start hlídky napříč řadou ze semínka (ovládání strážce na začátku kola postaví sem); hlídá kolem středu. Druhý
  // strážce téže řady začíná zrcadlově na opačné straně.
  const fresh = round === 0 ? params.guards : last ? 0 : 1;
  const posts: GuardPost[] = Array.from({ length: fresh }, (_, k) => {
    const index = firstGuard + k;
    const start = rng.int(STEAL.guard.w, STEAL.half - STEAL.guard.w);
    return { x: Math.floor(index / STEAL.rows.length) % 2 === 0 ? -start : start, z: STEAL.rows[index % STEAL.rows.length] as number, range: STEAL.guard.range, from: round };
  });
  return { spots, posts };
}

/** Kořist i strážci dalších kol leží v úrovni mrtví; ovládání je oživí na začátku jejich kola. */
const kindOf = { hero: 'hero', loot: 'loot', guard: 'guard' } as const;

export function stealParts(seed: number, params: StealParams, health: number | undefined): ModeParts {
  const seeds = roundSeeds(seed, params.rounds);
  const layouts: RoundLayout[] = [];
  let used = 0;
  for (let round = 0; round < params.rounds; round += 1) {
    const layout = layoutRound(seeds[round] as number, round, params, used);
    used += layout.posts.length;
    layouts.push(layout);
  }
  const posts: GuardPost[] = [...layouts.flatMap((layout) => layout.posts), { x: 0, z: STEAL.boss.z, range: STEAL.boss.range, from: params.rounds - 1, boss: true }];
  const spots = layouts.flatMap((layout) => layout.spots);

  const hero: BodyInit = { role: 'player', kind: kindOf.hero, x: 0, y: 0, z: STEAL.start, w: STEAL.hero.w, h: STEAL.hero.h, d: STEAL.hero.w, solid: false };
  const guards: BodyInit[] = posts.map((post) => {
    const size = post.boss === true ? STEAL.boss : STEAL.guard;
    return { role: 'chaser', kind: kindOf.guard, x: post.x, y: 0, z: post.z, w: size.w, h: size.h, d: size.w, solid: false, kinematic: true, ...(post.from === 0 && post.boss !== true ? {} : { template: true }) };
  });
  const last = params.rounds - 1;
  const loot: BodyInit[] = spots.map(([x, z], k) => {
    const round = Math.floor(k / params.loot);
    const size = round === last && k % params.loot === 0 ? STEAL.big : STEAL.loot;
    return { role: 'collectible', kind: kindOf.loot, x, y: 0, z, w: size.w, h: size.h, d: size.w, solid: false, ...(round === 0 ? {} : { template: true }) };
  });
  const firstGuard = 1;
  const firstLoot = firstGuard + guards.length;
  const keeper = firstLoot + loot.length;
  const counter: BodyInit = { role: 'thing', kind: kindOf.hero, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const bodies = [hero, ...guards, ...loot, counter];
  // Počítadlo háčků položí `withHooks` hned za tělesa úrovně.
  const hooks = bodies.length;
  const big = firstLoot + last * params.loot;
  const rules: PieceRef[] = [
    { id: 'steal_grab', params: { hooks } },
    { id: 'steal_home', params: { need: params.loot, points: STEAL.loot.points, big, bigPoints: STEAL.big.points } },
    { id: 'steal_tag', params: {} },
    { id: 'steal_clock', params: { keeper, ticks: roundTicksOf(params.rounds), last, boss: firstGuard + posts.length - 1 } },
    { id: 'out_of_health', params: {} },
    // Pilulka postupu HUD (`collectNeed`) čte cíl kola z `finish_collected`; tělo cíle svět nemá, takže nevystřelí.
    { id: 'finish_collected', params: { need: params.loot } },
  ];
  const control: PieceRef = { id: 'steal', params: { keeper, hooks, rounds: params.rounds, loot: { first: firstLoot, per: params.loot, spots: spots.map(([x, z]) => [x, z]) }, guards: { first: firstGuard, posts } } };
  const hooked = withHooks({ level: { bodies, length: 0 }, rules, bot: { id: 'steal_bot', params: { hooks } } }, seed, { rounds: params.rounds, upgrades: STEAL_UPGRADES, rarity: true, clear: 'win' });
  return { control, bot: hooked.bot, level: hooked.level, rules: hooked.rules, health: health ?? START_LIVES };
}

export const stealBases: ModeGeneratorPiece<StealParams> = {
  id: 'steal_bases',
  params: generatorParams,
  roles: ['player', 'collectible', 'chaser'],
  cost: (params) => ({ bodies: 3 + params.guards + params.rounds * (params.loot + 1), rules: 7 }),
  generate: (seed, params) => stealParts(seed, params, undefined).level,
  parts: stealParts,
};
