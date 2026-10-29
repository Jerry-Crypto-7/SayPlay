/**
 * Přežití ve vlnách (P66 T5): hrdina se hýbe joystickem a **střílí sám** na nejbližšího nepřítele v dostřelu, nepřátelé
 * z věty chodí ve vlnách od okrajů arény (i shora a zdola – aréna je na výšku vyšší než širší), mezi vlnami hráč
 * vybere 1 ze 3 vylepšení (háčky `arcade/hooks`, karty kreslí vrstva háčků) a poslední kolo je boss.
 * Od arény a střílečky se liší tím, že nemíří hráč a hra má kola s výběrem: hráč jen uhýbá a volí, kam jít.
 *
 * **Kola** jsou háčky `withHooks(…, { clear: 'win' })`: pravidlo `survivor_round` vyhlásí výhru, když kolo nemá
 * živého nepřítele ani čekající příchod; háčky z ní před posledním kolem udělají vyčištěné kolo, přestávku s nabídkou
 * a další kolo. Obsah kola (kdy a odkud kdo přijde) je hotový při stavbě z rozvrhu kol (`roundSeeds`, vlastní stream na
 * kolo); za běhu se počítá jen hodinami kola (`SURVIVOR_SLOTS.clock`) v tikách mimo přestávku.
 *
 * **Kdo co dělá v tiku:**
 * - ovládání `survivor`: hodiny kola, pohyb hrdiny, výběr cíle a rozestup střelby (ránu vystřelí pravidlo),
 *   chůze nepřátel za hrdinou s odstupem, stavový automat bosse, stárnutí jeho koulí;
 * - `survivor_fire` (stisk, hned za ovládáním): výstřel z předlohy střely s předstihem na cíl;
 * - `survivor_hit` (zásah): zásah ubere HP, poslední HP = body (s kombem), nepřítel zmizí a nechá krystal;
 * - `survivor_touch` (dotek): nepřítel, boss nebo koule bosse vezme život s milostí a odhodí hrdinu;
 * - `pickup` (knihovna): krystal → body; vzácnost mu dají háčky při vzniku (`hooks/rarity.ts`);
 * - `survivor_round` (tik): příchody vln, boss a jeho posily, salva koulí a dupnutí bosse, výhra kola.
 *
 * **Vylepšení** (`hooks/upgrades.ts`): `speed` a `magnet` promítne jádro samo, `extra_life` přidá život, `fire_rate`
 * (kratší rozestup) a `range` (dál a rychlejší střela) čte toto ovládání a pravidlo výstřelu (`upgradeLevel`).
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (`pure-rand` přes `createCompileRng` ze semínek kol), čas v tikách.
 * Míry a čtení stavu jsou v `survivor-world.ts`.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  type BodyInit,
  type ControlPiece,
  FLAG,
  HIT_GRACE,
  HP_MAX,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  ROLE,
  type RulePiece,
  START_LIVES,
  UNIT,
  bodyBase,
  bodyHp,
  graceOf,
} from '../contract';
import { roundOf, roundSeeds, upgradeLevel, withHooks } from '../hooks';
import { DIRECTIONS, directionOfAxis, directionToward } from './arena';
import { nextMultiplier } from './rules';
import {
  BOSS,
  BOSS_ATTACK_CODES,
  BOSS_CRYSTALS,
  BOSS_PHASE,
  type BossPhase,
  SURVIVOR,
  SURVIVOR_BODIES,
  SURVIVOR_SLOTS,
  SURVIVOR_UPGRADES,
  type SurvivorAttack,
  aimAt,
  alive,
  bossAimOf,
  bossAttackIndexOf,
  bossOf,
  bossPhaseOf,
  bossHpOf,
  bossTicksLeft,
  clockOf,
  copiesOf,
  enemiesOf,
  enraged,
  entryPoint,
  fireTicksAt,
  isBoss,
  kindOf,
  length,
  nearestEnemy,
  rangeAt,
  shotSpeedAt,
  waveCap,
  waveShape,
} from './survivor-world';

export * from './survivor-world';

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

// ---------------------------------------------------------------------------
// Ovládání

const template = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const half = z.int().min(4 * UNIT).max(20 * UNIT);

const controlParams = z
  .object({
    halfX: half,
    halfZ: half,
    /** Počítadlo přežití (`SURVIVOR_SLOTS`) a počítadlo háčků (kolo, stupně vylepšení). */
    keeper: template,
    hooks: template,
    /** Předlohy: boss (podpis bosse) a koule bosse. */
    boss: template,
    orb: template,
    /** Rychlost nepřátel v kolech (index kola); poslední kolo = posily bosse. */
    speeds: z.array(z.int().min(10).max(200)).min(2).max(5),
    /** Útoky bosse v cyklu (`BOSS_ATTACK_CODES`). */
    attacks: z.array(z.enum(BOSS_ATTACK_CODES)).min(1).max(3),
  })
  .strict();
export type SurvivorControlParams = z.infer<typeof controlParams>;

/** Hodiny kola: nové kolo (háčky ho po přestávce zvedly) je vynulují, každý tik mimo přestávku přičte jeden. */
function tickClock(state: ArcadeState, keeper: number, hooks: number): void {
  const base = bodyBase(keeper);
  const round = roundOf(state, hooks);
  if (state[base + SURVIVOR_SLOTS.round] !== round) {
    state[base + SURVIVOR_SLOTS.round] = round;
    state[base + SURVIVOR_SLOTS.clock] = 0;
  }
  state[base + SURVIVOR_SLOTS.clock] = (state[base + SURVIVOR_SLOTS.clock] as number) + 1;
  state[base + SURVIVOR_SLOTS.fired] = 0;
}

function moveHero(state: ArcadeState, player: number, axis: number): void {
  const p = bodyBase(player);
  const direction = directionOfAxis(axis);
  const dir = direction < 0 ? null : (DIRECTIONS[direction] as { dx: number; dz: number });
  const rate = dir === null ? SURVIVOR.friction : SURVIVOR.accel;
  state[p + BODY.vx] = toward(state[p + BODY.vx] as number, dir === null ? 0 : Math.trunc((dir.dx * SURVIVOR.speed) / 1000), rate);
  state[p + BODY.vz] = toward(state[p + BODY.vz] as number, dir === null ? 0 : Math.trunc((dir.dz * SURVIVOR.speed) / 1000), rate);
  if (direction >= 0) state[p + BODY.aux0] = direction;
}

/** Rozestup ran v `aux1` hrdiny; na nule a s cílem v dostřelu zapíše cíl výstřelu (vystřelí `survivor_fire`). */
function aimAndFire(state: ArcadeState, player: number, params: SurvivorControlParams): void {
  const p = bodyBase(player);
  const cooldown = state[p + BODY.aux1] as number;
  if (cooldown > 0) {
    state[p + BODY.aux1] = cooldown - 1;
    return;
  }
  const target = nearestEnemy(state, player, rangeAt(upgradeLevel(state, params.hooks, 'range')));
  if (target < 0) return;
  state[p + BODY.aux1] = fireTicksAt(upgradeLevel(state, params.hooks, 'fire_rate'));
  state[bodyBase(params.keeper) + SURVIVOR_SLOTS.fired] = target + 1;
}

/** Nepřítel jde za hrdinou rychlostí `speed`, s odstupem od ostatních (tím silněji, čím jsou blíž). */
function stepEnemy(state: ArcadeState, i: number, player: number, others: readonly number[], speed: number): void {
  const base = bodyBase(i);
  const p = bodyBase(player);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  const dx = (state[p + BODY.x] as number) - x;
  const dz = (state[p + BODY.z] as number) - zz;
  const aim = Math.max(1, length(dx, dz));
  let sx = Math.trunc((dx * 1000) / aim);
  let sz = Math.trunc((dz * 1000) / aim);
  for (const j of others) {
    if (j === i) continue;
    const other = bodyBase(j);
    const ox = x - (state[other + BODY.x] as number);
    const oz = zz - (state[other + BODY.z] as number);
    if (Math.abs(ox) >= SURVIVOR.separation || Math.abs(oz) >= SURVIVOR.separation) continue;
    const gap = length(ox, oz);
    if (gap >= SURVIVOR.separation) continue;
    const push = Math.trunc(((SURVIVOR.separation - gap) * 1500) / SURVIVOR.separation);
    if (gap === 0) sx += j < i ? push : -push;
    else {
      sx += Math.trunc((ox * push) / gap);
      sz += Math.trunc((oz * push) / gap);
    }
  }
  const want = directionToward(sx, sz);
  const dir = want < 0 ? { dx: 0, dz: 0 } : (DIRECTIONS[want] as { dx: number; dz: number });
  state[base + BODY.vx] = toward(state[base + BODY.vx] as number, Math.trunc((dir.dx * speed) / 1000), 12);
  state[base + BODY.vz] = toward(state[base + BODY.vz] as number, Math.trunc((dir.dz * speed) / 1000), 12);
}

function setBoss(state: ArcadeState, boss: number, phase: BossPhase, attack: number, aim: number, ticks: number): void {
  const base = bodyBase(boss);
  state[base + BODY.aux0] = phase | (attack << 4) | (aim << 8);
  state[base + BODY.aux1] = ticks;
}

/**
 * Jeden tik bosse: příchod → (náběh → telegraf → útok → oddech) dokola. Telegraf zamkne směr na hrdinu; rozběh jede
 * po něm, dupnutí a salvu vydá pravidlo `survivor_round` v prvním tiku útoku. Rozzuřený boss kratší telegraf i oddech.
 */
function stepBoss(state: ArcadeState, boss: number, player: number, params: SurvivorControlParams): void {
  const base = bodyBase(boss);
  const p = bodyBase(player);
  const dx = (state[p + BODY.x] as number) - (state[base + BODY.x] as number);
  const dz = (state[p + BODY.z] as number) - (state[base + BODY.z] as number);
  const phase = bossPhaseOf(state, boss);
  const attack = bossAttackIndexOf(state, boss);
  const aim = bossAimOf(state, boss);
  const left = bossTicksLeft(state, boss) - 1;
  const angry = enraged(state, boss, params.boss);
  const walk = (direction: number, speed: number): void => {
    const dir = direction < 0 ? { dx: 0, dz: 0 } : (DIRECTIONS[direction] as { dx: number; dz: number });
    state[base + BODY.vx] = Math.trunc((dir.dx * speed) / 1000);
    state[base + BODY.vz] = Math.trunc((dir.dz * speed) / 1000);
  };
  if (phase === BOSS_PHASE.enter) {
    setBoss(state, boss, BOSS_PHASE.approach, attack, aim, BOSS.approach);
    walk(directionToward(dx, dz), BOSS.speed);
    return;
  }
  if (phase === BOSS_PHASE.approach) {
    walk(directionToward(dx, dz), BOSS.speed);
    if (left > 0) state[base + BODY.aux1] = left;
    else setBoss(state, boss, BOSS_PHASE.telegraph, attack, Math.max(0, directionToward(dx, dz)), angry ? BOSS.enragedTelegraph : BOSS.telegraph);
    return;
  }
  if (phase === BOSS_PHASE.telegraph) {
    walk(-1, 0);
    if (left > 0) state[base + BODY.aux1] = left;
    else setBoss(state, boss, BOSS_PHASE.act, attack, aim, params.attacks[attack] === 'charge' ? BOSS.charge.ticks : BOSS.strike);
    return;
  }
  if (phase === BOSS_PHASE.act) {
    if (params.attacks[attack] === 'charge') walk(aim, BOSS.charge.speed);
    else walk(-1, 0);
    if (left > 0) state[base + BODY.aux1] = left;
    else setBoss(state, boss, BOSS_PHASE.recover, attack, aim, angry ? BOSS.enragedRecover : BOSS.recover);
    return;
  }
  walk(-1, 0);
  if (left > 0) state[base + BODY.aux1] = left;
  else setBoss(state, boss, BOSS_PHASE.approach, (attack + 1) % params.attacks.length, aim, angry ? Math.trunc(BOSS.approach / 2) : BOSS.approach);
}

/** Rychlost, se kterou tělo zůstane v aréně: složka, která by ho vynesla ven, se zkrátí. */
function keepInside(state: ArcadeState, body: number, halfX: number, halfZ: number): void {
  const base = bodyBase(body);
  const limitX = halfX - Math.ceil((state[base + BODY.w] as number) / 2);
  const limitZ = halfZ - Math.ceil((state[base + BODY.d] as number) / 2);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  state[base + BODY.vx] = Math.max(-limitX - x, Math.min(limitX - x, state[base + BODY.vx] as number));
  state[base + BODY.vz] = Math.max(-limitZ - zz, Math.min(limitZ - zz, state[base + BODY.vz] as number));
}

/** Koule bosse stárnou (`aux1`); dohasnutá nebo venku zmizí. */
function ageOrbs(state: ArcadeState, params: SurvivorControlParams): void {
  for (const i of copiesOf(state, params.orb)) {
    const base = bodyBase(i);
    const age = (state[base + BODY.aux1] as number) + 1;
    state[base + BODY.aux1] = age;
    const out = Math.abs(state[base + BODY.x] as number) > params.halfX || Math.abs(state[base + BODY.z] as number) > params.halfZ;
    if (age > BOSS.volley.life || out) state[base + BODY.flags] = (state[base + BODY.flags] as number) & ~FLAG.alive;
  }
}

/**
 * Ovládání přežití. Pořadí v tiku: hodiny kola → pohyb hrdiny → cíl a rozestup střelby → nepřátelé (rychlostí kola)
 * a boss → koule. Hrdina i nepřátelé zůstanou v aréně.
 */
export const survivorControl: ControlPiece<SurvivorControlParams> = {
  id: 'survivor',
  params: controlParams,
  roles: ['player', 'enemy', 'projectile', 'collectible', 'hazard'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    tickClock(state, params.keeper, params.hooks);
    moveHero(state, player, input.axis);
    aimAndFire(state, player, params);
    const enemies = enemiesOf(state);
    const speed = params.speeds[Math.min(params.speeds.length - 1, roundOf(state, params.hooks))] as number;
    for (const i of enemies) {
      if (isBoss(state, i, params.boss)) stepBoss(state, i, player, params);
      else stepEnemy(state, i, player, enemies, speed);
      keepInside(state, i, params.halfX, params.halfZ);
    }
    ageOrbs(state, params);
    keepInside(state, player, params.halfX, params.halfZ);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const fireParams = z.object({ keeper: template, hooks: template, shot: template }).strict();

/** Výstřel (stisk, hned za ovládáním): z hrdiny na cíl, který ovládání v tomto tiku vybralo. */
export const survivorFire: RulePiece<z.infer<typeof fireParams>> = {
  id: 'survivor_fire',
  params: fireParams,
  roles: ['player', 'projectile'],
  trigger: 'press',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: ({ state, player }, params) => {
    const target = (state[bodyBase(params.keeper) + SURVIVOR_SLOTS.fired] as number) - 1;
    if (target < 0 || !alive(state, target)) return [];
    const p = bodyBase(player);
    const { vx, vz } = aimAt(state, player, target, shotSpeedAt(upgradeLevel(state, params.hooks, 'range')));
    return [{ kind: 'spawn', template: params.shot, x: state[p + BODY.x] as number, y: SURVIVOR.shot.y, z: state[p + BODY.z] as number, vx, vy: 0, vz }];
  },
};

const hitParams = z
  .object({
    crystal: template,
    boss: template,
    /** Počítadlo komba (P46C T3): série padlých zvedá násobič; doplní ho `withCombo` hry `genre.v6` (`hookedComboSources`). */
    combo: template.optional(),
  })
  .strict();
export type SurvivorHitParams = z.infer<typeof hitParams>;

/**
 * Padlý nepřítel `body`: body (s kombem), zmizí a nechá krystal, je-li kde; boss víc bodů a kruh krystalů. Celé
 * v obalu `ifAlive`: dvě střely do téhož nepřítele v jednom tiku ho srazí jen jednou.
 */
export function defeat(state: ArcadeState, body: number, params: SurvivorHitParams): ArcadeEffect {
  const base = bodyBase(body);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  const boss = isBoss(state, body, params.boss);
  const multiplier = params.combo === undefined || boss ? 1 : nextMultiplier(state, params.combo);
  const effects: ArcadeEffect[] = [
    { kind: 'score', amount: boss ? SURVIVOR.points.boss : SURVIVOR.points.kill * multiplier },
    { kind: 'despawn', body },
  ];
  if (params.combo !== undefined && !boss) effects.push({ kind: 'combo', body: params.combo, multiplier });
  const drops = boss ? BOSS_CRYSTALS : copiesOf(state, params.crystal).length < SURVIVOR.crystals ? 1 : 0;
  for (let k = 0; k < drops; k += 1) {
    const dir = DIRECTIONS[Math.trunc((k * 32) / BOSS_CRYSTALS)] as { dx: number; dz: number };
    const spread = boss ? 1600 : 0;
    effects.push({ kind: 'spawn', template: params.crystal, x: x + Math.trunc((dir.dx * spread) / 1000), y: 0, z: zz + Math.trunc((dir.dz * spread) / 1000), vx: 0, vy: 0, vz: 0 });
  }
  return { kind: 'ifAlive', body, effects };
}

/** Zásah střelou: nepřítel ztratí HP; poslední HP = padl (`defeat`). */
export const survivorHit: RulePiece<SurvivorHitParams> = {
  id: 'survivor_hit',
  params: hitParams,
  roles: ['projectile', 'enemy'],
  trigger: 'hit',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other, source, player }, params) => {
    if (other < 0 || state[bodyBase(other) + BODY.role] !== ROLE.enemy || !alive(state, other)) return [];
    if (bodyHp(state, other) <= 1) return [defeat(state, other, params)];
    return [{ kind: 'hit', body: other, by: source < 0 ? player : source, amount: 1 }];
  },
};

const touchParams = z.object({ orb: template }).strict();

/** Dotek nepřítele nebo bosse vezme život (s milostí) a hrdinu odhodí; koule bosse vezme život a zmizí. */
export const survivorTouch: RulePiece<z.infer<typeof touchParams>> = {
  id: 'survivor_touch',
  params: touchParams,
  roles: ['player', 'enemy', 'hazard'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params) => {
    const role = state[bodyBase(other) + BODY.role];
    const orb = role === ROLE.hazard && kindOf(state, other) === kindOf(state, params.orb);
    if ((role !== ROLE.enemy && !orb) || graceOf(state, player) > 0) return [];
    const hurt: ArcadeEffect = { kind: 'damage', amount: 1, grace: HIT_GRACE };
    return orb ? [hurt, { kind: 'despawn', body: other }] : [hurt, { kind: 'knockback', body: other, speed: SURVIVOR.knockback }];
  },
};

/** Příchod: hodiny kola, předloha a směr od hrdiny (0..31); skupina = víc příchodů v témže tiku. */
const arrival = z.tuple([z.int().min(1).max(ARCADE_LIMITS.maxTicks), template, z.int().min(0).max(31)]);
export type SurvivorArrival = z.infer<typeof arrival>;

const roundParams = z
  .object({
    keeper: template,
    hooks: template,
    halfX: half,
    halfZ: half,
    /** Příchody vln po kolech (bez posledního – to je boss), seřazené podle hodin. */
    waves: z.array(z.array(arrival).min(1).max(64)).min(1).max(4),
    /** Boss posledního kola: předloha, hodiny příchodu, posily (předloha, směry v cyklu) a koule. */
    boss: z.object({ template, at: z.int().min(1).max(ARCADE_LIMITS.maxTicks), minion: template, dirs: z.array(z.int().min(0).max(31)).min(1).max(32), orb: template }).strict(),
    attacks: z.array(z.enum(BOSS_ATTACK_CODES)).min(1).max(3),
  })
  .strict();
export type SurvivorRoundParams = z.infer<typeof roundParams>;

/** Hodiny kola, ve kterých přijdou posily bosse: první `first`, rozestup s každou skupinou o `shrink` kratší, nejmíň `minGap`. */
export function minionTicks(until: number): number[] {
  const out: number[] = [];
  for (let at: number = BOSS.minion.first, gap: number = BOSS.minion.gap; at <= until; at += gap, gap = Math.max(BOSS.minion.minGap, gap - BOSS.minion.shrink)) out.push(at);
  return out;
}

/** Index skupiny posil, která přijde v hodinách `clock`, nebo −1. */
function minionWave(clock: number): number {
  for (let k = 0, at: number = BOSS.minion.first, gap: number = BOSS.minion.gap; at <= clock; k += 1, at += gap, gap = Math.max(BOSS.minion.minGap, gap - BOSS.minion.shrink)) {
    if (at === clock) return k;
  }
  return -1;
}

/** Příchod předlohy `template` ze směru `dir`, člen `k` skupiny o `size`. */
function arrive(state: ArcadeState, player: number, params: SurvivorRoundParams, from: number, dir: number, k: number, size: number): ArcadeEffect {
  const at = entryPoint(state, player, dir, (2 * k - (size - 1)) * 650, params.halfX, params.halfZ);
  return { kind: 'spawn', template: from, x: at.x, y: 0, z: at.z, vx: 0, vy: 0, vz: 0 };
}

/** Útok bosse v prvním tiku fáze útoku: salva koulí do kruhu, nebo dupnutí (rána hrdinovi v dosahu). */
function bossStrike(state: ArcadeState, player: number, boss: number, params: SurvivorRoundParams): ArcadeEffect[] {
  if (bossPhaseOf(state, boss) !== BOSS_PHASE.act || bossTicksLeft(state, boss) !== BOSS.strike) return [];
  const attack = params.attacks[bossAttackIndexOf(state, boss)];
  const base = bodyBase(boss);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  if (attack === 'shoot') {
    const count = enraged(state, boss, params.boss.template) ? BOSS.volley.enraged : BOSS.volley.count;
    return Array.from({ length: count }, (_, k): ArcadeEffect => {
      const dir = DIRECTIONS[Math.trunc((k * 32) / count)] as { dx: number; dz: number };
      return { kind: 'spawn', template: params.boss.orb, x, y: SURVIVOR.orb.y, z: zz, vx: Math.trunc((dir.dx * BOSS.volley.speed) / 1000), vy: 0, vz: Math.trunc((dir.dz * BOSS.volley.speed) / 1000) };
    });
  }
  if (attack !== 'stomp' || graceOf(state, player) > 0) return [];
  const p = bodyBase(player);
  const gap = length((state[p + BODY.x] as number) - x, (state[p + BODY.z] as number) - zz);
  return gap <= BOSS.stomp.radius ? [{ kind: 'damage', amount: 1, grace: HIT_GRACE }, { kind: 'knockback', body: boss, speed: SURVIVOR.knockback }] : [];
}

/**
 * Průběh kola (tik): příchody vln podle hodin kola; v posledním kole boss a s časem hustší posily (do stropu živých),
 * útok bosse a výhra po jeho pádu. Nepřítel, kterého dvě rány téhož tiku srazily na 0 HP, padne tady. Výhra kola =
 * všechny příchody za sebou a nikdo živý; háčky z ní udělají konec kola.
 */
export const survivorRound: RulePiece<SurvivorRoundParams> = {
  id: 'survivor_round',
  params: roundParams,
  roles: ['player', 'enemy', 'hazard'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const clock = clockOf(state, params.keeper);
    const effects: ArcadeEffect[] = [];
    const enemies = enemiesOf(state);
    for (const i of enemies) if (bodyHp(state, i) === 0) effects.push(defeat(state, i, { crystal: SURVIVOR_BODIES.crystal, boss: params.boss.template }));
    const wave = params.waves[roundOf(state, params.hooks)];
    if (wave !== undefined) {
      const now = wave.filter(([at]) => at === clock);
      now.forEach(([, from, dir], k) => effects.push(arrive(state, player, params, from, dir, k, now.length)));
      if (clock > (wave[wave.length - 1] as SurvivorArrival)[0] && enemies.length === 0) effects.push({ kind: 'win' });
      return effects;
    }
    const boss = bossOf(state, params.boss.template);
    if (clock === params.boss.at) effects.push(arrive(state, player, params, params.boss.template, 0, 0, 1));
    if (clock > params.boss.at && boss < 0) return [...effects, { kind: 'win' }];
    if (boss < 0) return effects;
    effects.push(...bossStrike(state, player, boss, params));
    const group = minionWave(clock);
    const crowd = enemies.length - 1;
    if (group >= 0 && crowd < BOSS.minion.cap) {
      const dir = params.boss.dirs[group % params.boss.dirs.length] as number;
      // Skupiny rostou: po každých `grow` skupinách o jednoho víc – kdo bosse nesrazí včas, toho posily zavalí.
      const size = Math.min(BOSS.minion.group + Math.floor(group / BOSS.minion.grow), BOSS.minion.cap - crowd);
      for (let k = 0; k < size; k += 1) effects.push(arrive(state, player, params, params.boss.minion, dir, k, size));
    }
    return effects;
  },
};

/** Pravidla přežití – `library.ts` je rozbalí do `rules`. */
export const SURVIVOR_RULES: Readonly<Record<string, RulePiece>> = {
  survivor_fire: survivorFire as RulePiece,
  survivor_hit: survivorHit as RulePiece,
  survivor_touch: survivorTouch as RulePiece,
  survivor_round: survivorRound as RulePiece,
};

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    /** Nepřátel ve vlnách dohromady (věta „fights 40 zombies“, `COUNT_PARAMS.survivor`). */
    enemies: z.int().min(SURVIVOR.enemies.min).max(SURVIVOR.enemies.max).default(SURVIVOR.enemies.default),
    /** Kola (háčky): poslední je boss. */
    rounds: z.int().min(SURVIVOR.rounds.min).max(SURVIVOR.rounds.max).default(SURVIVOR.rounds.default),
    /** První útok bosse (režisér: `boss.attack`); bez něj rozběh a salva. */
    attack: z.enum(BOSS_ATTACK_CODES).optional(),
  })
  .strict();
export type SurvivorParams = z.infer<typeof generatorParams>;

/** Útoky bosse v cyklu: zvolený napřed, pak rozběh; bez volby (nebo s rozběhem) rozběh a salva. */
export const bossAttacks = (attack: SurvivorAttack | undefined): SurvivorAttack[] => (attack === undefined || attack === 'charge' ? ['charge', 'shoot'] : [attack, 'charge']);

/**
 * Kolik nepřátel do které vlny: poměr 2 : 3 : 4 … – každá další vlna je větší –, každá nejvýš `waveCap`. Věta, která
 * chce víc, než se do vln vejde („60 zombies“ ve dvou vlnách), dostane, co se vejde; text cíle čte tentýž součet.
 */
export function waveSizes(enemies: number, waves: number): number[] {
  const weights = Array.from({ length: waves }, (_, k) => 2 + k);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map((weight) => Math.max(2, Math.floor((enemies * weight) / total)));
  for (let left = enemies - sizes.reduce((sum, size) => sum + size, 0), k = waves - 1; left > 0; left -= 1, k = (k + waves - 1) % waves) sizes[k] = (sizes[k] as number) + 1;
  return sizes.map((size, k) => Math.min(size, waveCap(k, waves)));
}

/** Nepřátel ve vlnách hry s `enemies` a `rounds` koly, jak je generátor opravdu postaví. */
export const wavedEnemies = (enemies: number, rounds: number): number => waveSizes(enemies, rounds - 1).reduce((sum, size) => sum + size, 0);

const body = (role: BodyInit['role'], kind: string, size: { readonly w: number; readonly h: number; readonly d: number }, extra: Partial<BodyInit> = {}): BodyInit => ({ role, kind, x: 0, y: 0, z: 0, ...size, solid: false, ...extra });

/** Příchody vlny `k`: skupiny po `group` každých `gap` tiků, směry ze streamu kola (skupina ze stejné strany). */
function waveArrivals(seed: number, k: number, size: number, waves: number): SurvivorArrival[] {
  const rng = createCompileRng(seed, 'spawn');
  const shape = waveShape(k, waves);
  const out: SurvivorArrival[] = [];
  for (let n = 0, at: number = shape.start; n < size; at += shape.gap) {
    const dir = rng.int(0, 31);
    for (let m = 0; m < shape.group && n < size; m += 1, n += 1) out.push([at, SURVIVOR_BODIES.firstWave + k, dir]);
  }
  return out;
}

/** Tvrzení „hratelné z konstrukce“ nad úrovní a rozvrhem vln; prázdné pole = hratelné. */
export function checkSurvivorLevel(level: ArcadeLevel, waves: readonly (readonly SurvivorArrival[])[]): string[] {
  const issues: string[] = [];
  const hero = level.bodies[0];
  if (hero === undefined || hero.role !== 'player') return ['no player'];
  if (Math.abs(hero.x) * 2 > SURVIVOR.halfX || Math.abs(hero.z) * 2 > SURVIVOR.halfZ) issues.push('the hero does not start near the middle');
  waves.forEach((wave, k) => {
    if (wave.length === 0) issues.push(`wave ${String(k + 1)} brings nobody`);
    if (wave.some(([at], n) => at < 1 || (n > 0 && at < (wave[n - 1] as SurvivorArrival)[0]))) issues.push(`wave ${String(k + 1)} is out of order`);
    if (wave.some(([, from]) => level.bodies[from]?.role !== 'enemy' || level.bodies[from]?.template !== true)) issues.push(`wave ${String(k + 1)} brings something that is not an enemy`);
  });
  for (const [index, entry] of level.bodies.entries()) {
    if (entry.role === 'enemy' && ((entry.hp ?? 0) < 1 || (entry.hp ?? 0) > HP_MAX)) issues.push(`enemy template ${String(index)} has no HP`);
  }
  return issues;
}

/** Tělesa úrovně: hrdina uprostřed, počítadlo přežití, předlohy střely, krystalu, koule, bosse, posil a vln. */
function survivorLevel(waves: number): BodyInit[] {
  return [
    body('player', 'player', SURVIVOR.hero),
    body('thing', 'player', { w: 1, h: 1, d: 1 }, { template: true }),
    body('projectile', 'bullet', SURVIVOR.shot, { y: SURVIVOR.shot.y, template: true, lifetime: SURVIVOR.shot.life }),
    body('collectible', 'crystal', SURVIVOR.crystal, { template: true }),
    body('hazard', 'orb', SURVIVOR.orb, { y: SURVIVOR.orb.y, template: true }),
    body('enemy', 'boss', SURVIVOR.boss, { template: true, hp: bossHpOf(waves) }),
    body('enemy', 'enemy', SURVIVOR.enemy, { template: true, hp: BOSS.minion.hp }),
    ...Array.from({ length: waves }, (_, k) => body('enemy', 'enemy', SURVIVOR.enemy, { template: true, hp: waveShape(k, waves).hp })),
  ];
}

/** Volné sloty spawnu: nejvíc živých naráz (vlna, střely, krystaly, koule, boss s posilami) s rezervou. */
export const SPAWN_SLOTS = 56;

/**
 * Režim `survivor.default` (generátor `survivor_waves`): `rounds − 1` vln z `enemies` nepřátel, pak boss. Háčky nese
 * generátor sám (`withHooks`, kolo končí výhrou pravidla): kola, výběr 1 ze 3 ze `SURVIVOR_UPGRADES` mezi koly
 * a vzácnost krystalů; boss posledního kola je předloha bosse háčků (`boss_enter`). Životy ze specu (výchozí
 * `START_LIVES`); prohra = životy na nule.
 */
export const survivorWaves: ModeGeneratorPiece<SurvivorParams> = {
  id: 'survivor_waves',
  params: generatorParams,
  roles: ['player', 'enemy', 'projectile', 'collectible', 'hazard'],
  cost: (params) => ({ bodies: 8 + params.rounds + SPAWN_SLOTS, rules: 8 }),
  generate: (_seed, params) => ({ bodies: survivorLevel(params.rounds - 1), length: 0, spawnSlots: SPAWN_SLOTS }),
  parts: (seed, params, health): ModeParts => {
    const waves = params.rounds - 1;
    const level: ArcadeLevel = { bodies: survivorLevel(waves), length: 0, spawnSlots: SPAWN_SLOTS };
    const seeds = roundSeeds(seed, params.rounds);
    const schedule = waveSizes(params.enemies, waves).map((size, k) => waveArrivals(seeds[k] as number, k, size, waves));
    const bossRng = createCompileRng(seeds[waves] as number, 'spawn');
    const dirs = Array.from({ length: 16 }, () => bossRng.int(0, 31));
    const attacks = bossAttacks(params.attack);
    const speeds = [...Array.from({ length: waves }, (_, k) => waveShape(k, waves).speed), BOSS.minion.speed];
    // Počítadlo háčků přidá `withHooks` hned za tělesa úrovně – robot ho potřebuje znát už teď (dostřel, nabídka).
    const hooks = level.bodies.length;
    // Robot přežití volí karty sám (rána napřed, `SURVIVOR_PICK_PRIORITY`), obal `hooks_bot` od `withHooks` se nebere.
    const bot: PieceRef = { id: 'survivor_bot', params: { hooks, attacks } };
    const hooked = withHooks({ level, rules: [], bot }, seed, { rounds: params.rounds, clear: 'win', upgrades: SURVIVOR_UPGRADES, rarity: true });
    const { keeper } = SURVIVOR_BODIES;
    const rules: PieceRef[] = [
      { id: 'survivor_fire', params: { keeper, hooks, shot: SURVIVOR_BODIES.shot } },
      { id: 'survivor_hit', params: { crystal: SURVIVOR_BODIES.crystal, boss: SURVIVOR_BODIES.boss } },
      { id: 'survivor_touch', params: { orb: SURVIVOR_BODIES.orb } },
      { id: 'pickup', params: { points: SURVIVOR.points.crystal } },
      {
        id: 'survivor_round',
        params: { keeper, hooks, halfX: SURVIVOR.halfX, halfZ: SURVIVOR.halfZ, waves: schedule, boss: { template: SURVIVOR_BODIES.boss, at: BOSS.at, minion: SURVIVOR_BODIES.minion, dirs, orb: SURVIVOR_BODIES.orb }, attacks },
      },
      { id: 'out_of_health', params: {} },
      ...hooked.rules.map((ref) => (ref.id === 'hooks' ? { id: 'hooks', params: { ...ref.params, boss: SURVIVOR_BODIES.boss } } : ref)),
    ];
    return {
      control: { id: 'survivor', params: { halfX: SURVIVOR.halfX, halfZ: SURVIVOR.halfZ, keeper, hooks, boss: SURVIVOR_BODIES.boss, orb: SURVIVOR_BODIES.orb, speeds, attacks } },
      bot,
      level: hooked.level,
      rules,
      issues: checkSurvivorLevel(level, schedule),
      health: health ?? START_LIVES,
    };
  },
};
