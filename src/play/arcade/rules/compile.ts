/**
 * Překlad pravidel ze specu na kusy jádra (P29A, T2).
 *
 * Pravidlo z `rules/schema.ts` mluví jmény rolí; jádro čísly. Překlad:
 *
 * 1. **Role → kód.** Hráč je `ROLE.player`. Role, jejíž druh už základní
 *    úroveň staví (mince běžce = `collectible`), dostane kód toho druhu – pravidlo
 *    pak míří na tělesa generátoru. Ostatní role jsou **věci pravidel**: kód
 *    `THING_ROLE_BASE + k` a tělesa, která překlad sám rozmístí.
 * 2. **Pravidlo → `PieceRef`** na jeden z pěti kusů podle spouštěče
 *    (`rule_contact`, `rule_press`, `rule_tick`, `rule_counter`, `rule_hit`) s
 *    parametry, ve kterých už jsou kódy místo jmen. Jádro je spouští stejně jako
 *    ručně psaná pravidla z `pieces/rules.ts`.
 *
 * Když pravidla sama vyhrávají (`win`) a ovládání je volný pohyb, hraje se na
 * **dvorku** (`yardParts`): prázdná ohrazená plocha, kde věci stojí tak, aby
 * slovesa dávala smysl – dveře a brána ve zdi napříč, cíl za ní, věci k nošení
 * před ní. Aréna s buňkami by slovesa přehlušila (hráč by vyhrál pojídáním).
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';
import type { GameSpecV1, RoleKind } from '@/play/spec';

import type { ArcadeParts } from '../addons';
import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeRole,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  FLAG,
  HEADER,
  type PieceRef,
  ROLE,
  type RuleContext,
  type RulePiece,
  type RuleTrigger,
  UNIT,
  bodyBase,
} from '../contract';
import { ARENA } from '../pieces/arena';
import { RULE_COUNTERS, type Rule, type RuleDo, type RuleIf } from './schema';

/** První kód role věci pravidel; pod ním jsou role jádra (`ROLE`), jejichž čísla jsou v hashi. */
export const THING_ROLE_BASE = 32;
/** Nejvýš tolik těl jedné role věci – `count` z věty („100 coins“) by jinak vyčerpal jádro. */
export const THING_MAX_COUNT = 8;
/** Rezerva slotů pro efekt `spawn` pravidel. */
export const RULE_SPAWN_SLOTS = 8;

// ---------------------------------------------------------------------------
// Parametry přeložených pravidel

const code = z.int().min(0).max(255);
const counterName = z.enum(RULE_COUNTERS);
const target = z.enum(['other', 'self', 'held']);

const compiledWhen = z.union([
  z.object({ contact: z.tuple([code, code]) }).strict(),
  z.object({ press: z.int().min(1) }).strict(),
  z.object({ every: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict(),
  z.object({ counter: z.object({ name: counterName, atLeast: z.int() }).strict() }).strict(),
  z.object({ hit: code }).strict(),
]);

const compiledIf = z.union([
  z.object({ holding: code }).strict(),
  z.object({ notHolding: z.literal(true) }).strict(),
  z.object({ counter: z.object({ name: counterName, atLeast: z.int().optional(), below: z.int().optional() }).strict() }).strict(),
  /** `within` už v jednotkách jádra. */
  z.object({ near: z.object({ role: code, within: z.int().min(0) }).strict() }).strict(),
]);

const compiledDo = z.union([
  z.object({ score: z.int() }).strict(),
  z.object({ damage: z.int() }).strict(),
  z.object({ win: z.literal(true) }).strict(),
  z.object({ lose: z.literal(true) }).strict(),
  z.object({ despawn: target }).strict(),
  /** `template` = index předlohy ve světě. */
  z.object({ spawn: z.object({ template: z.int().min(0), at: z.enum(['player', 'other']) }).strict() }).strict(),
  z.object({ count: z.object({ counter: counterName, amount: z.int() }).strict() }).strict(),
  z.object({ respawn: z.literal(true) }).strict(),
  z.object({ checkpoint: target }).strict(),
  z.object({ grab: target }).strict(),
  z.object({ release: z.literal(true) }).strict(),
  z.object({ throwHeld: z.literal(true) }).strict(),
  z.object({ push: target }).strict(),
  z.object({ toggle: code }).strict(),
]);

export const compiledRuleSchema = z
  .object({
    /** Id pravidla ze specu – stopa výstřelů (T4) ho vrací robotovi i kritikovi. */
    id: z.string(),
    verb: z.string(),
    when: compiledWhen,
    if: z.array(compiledIf),
    do: z.array(compiledDo),
  })
  .strict();
export type CompiledRule = z.infer<typeof compiledRuleSchema>;
type CompiledDo = z.infer<typeof compiledDo>;
type CompiledIf = z.infer<typeof compiledIf>;

// ---------------------------------------------------------------------------
// Vyhodnocení za běhu

const roleAt = (state: Int32Array, body: number): number => state[bodyBase(body) + BODY.role] as number;
const isAlive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Index neseného těla, nebo −1. */
export const heldOf = (state: Int32Array): number => (state[HEADER.held] as number) - 1;

/** Mezera mezi obrysy dvou těl v rovině x/z (0 = dotýkají se nebo překrývají). */
function gap(state: Int32Array, a: number, b: number): number {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  const dx = Math.max(0, Math.abs((state[pa + BODY.x] as number) - (state[pb + BODY.x] as number)) - Math.ceil(((state[pa + BODY.w] as number) + (state[pb + BODY.w] as number)) / 2));
  const dz = Math.max(0, Math.abs((state[pa + BODY.z] as number) - (state[pb + BODY.z] as number)) - Math.ceil(((state[pa + BODY.d] as number) + (state[pb + BODY.d] as number)) / 2));
  return Math.max(dx, dz);
}

/** Nejbližší živé tělo role do vzdálenosti `within` od hráče (shoda: nižší index), nebo −1. */
function nearest(state: Int32Array, player: number, role: number, within: number): number {
  const count = state[HEADER.bodyCount] as number;
  let best = -1;
  let bestGap = within + 1;
  for (let i = 0; i < count; i += 1) {
    if (i === player || roleAt(state, i) !== role || !isAlive(state, i)) continue;
    const d = gap(state, player, i);
    if (d < bestGap) {
      best = i;
      bestGap = d;
    }
  }
  return best;
}

const counterValue = (state: Int32Array, name: (typeof RULE_COUNTERS)[number]): number => state[HEADER.counters + COUNTER[name]] as number;

/** Podmínky platí? Vrátí tělo `other` vybrané podmínkou `near` (nebo to, které přišlo), −2 = neplatí. */
function check(state: Int32Array, player: number, conditions: readonly CompiledIf[], other: number): number {
  let picked = other;
  for (const cond of conditions) {
    if ('holding' in cond) {
      const held = heldOf(state);
      if (held < 0 || !isAlive(state, held) || roleAt(state, held) !== cond.holding) return -2;
    } else if ('notHolding' in cond) {
      if (heldOf(state) >= 0) return -2;
    } else if ('counter' in cond) {
      const value = counterValue(state, cond.counter.name);
      if (cond.counter.atLeast !== undefined && value < cond.counter.atLeast) return -2;
      if (cond.counter.below !== undefined && value >= cond.counter.below) return -2;
    } else {
      const found = nearest(state, player, cond.near.role, cond.near.within);
      if (found < 0) return -2;
      if (picked < 0) picked = found;
    }
  }
  return picked;
}

/** Tělo, na které efekt míří; −1 = žádné (efekt se vynechá). */
function bodyOf(state: Int32Array, which: 'other' | 'self' | 'held', self: number, other: number): number {
  if (which === 'held') return heldOf(state);
  return which === 'self' ? self : other;
}

function effectsOf(ctx: RuleContext, rule: CompiledRule, self: number, other: number): ArcadeEffect[] {
  const { state, player } = ctx;
  const out: ArcadeEffect[] = [];
  const at = (body: number): { x: number; z: number } => ({ x: state[bodyBase(body) + BODY.x] as number, z: state[bodyBase(body) + BODY.z] as number });
  for (const effect of rule.do as readonly CompiledDo[]) {
    if ('score' in effect) out.push({ kind: 'score', amount: effect.score });
    else if ('damage' in effect) out.push({ kind: 'damage', amount: effect.damage });
    else if ('win' in effect) out.push({ kind: 'win' });
    else if ('lose' in effect) out.push({ kind: 'lose' });
    else if ('respawn' in effect) out.push({ kind: 'respawn' });
    else if ('count' in effect) out.push({ kind: 'count', counter: effect.count.counter, amount: effect.count.amount });
    else if ('despawn' in effect) {
      const body = bodyOf(state, effect.despawn, self, other);
      if (body >= 0 && body !== player) out.push({ kind: 'despawn', body });
    } else if ('checkpoint' in effect) {
      const body = bodyOf(state, effect.checkpoint, self, other);
      if (body >= 0) out.push({ kind: 'checkpoint', body });
    } else if ('spawn' in effect) {
      const from = effect.spawn.at === 'player' ? player : other;
      if (from < 0) continue;
      const { x, z } = at(from);
      out.push({ kind: 'spawn', template: effect.spawn.template, x, y: 0, z, vx: 0, vy: 0, vz: 0 });
    } else if ('grab' in effect || 'push' in effect) {
      const body = bodyOf(state, 'grab' in effect ? effect.grab : effect.push, self, other);
      if (body >= 0 && body !== player) out.push({ kind: 'grab' in effect ? 'grab' : 'push', body });
    } else if ('release' in effect) out.push({ kind: 'release' });
    else if ('throwHeld' in effect) out.push({ kind: 'throwHeld' });
    else out.push({ kind: 'toggle', role: effect.toggle });
  }
  return out;
}

/** Jedno vyhodnocení: podmínky, pak efekty. `other` −1, když spouštěč tělo nemá. */
function evaluate(ctx: RuleContext, rule: CompiledRule, self: number, other: number): readonly ArcadeEffect[] {
  const picked = check(ctx.state, ctx.player, rule.if, other);
  if (picked === -2) return [];
  return effectsOf(ctx, rule, self, picked);
}

/** Kontakt dvou věcí bez hráče: každá dvojice živých těl rolí `a`×`b`, která se překrývá. */
function pairContacts(ctx: RuleContext, rule: CompiledRule, a: number, b: number): ArcadeEffect[] {
  const { state } = ctx;
  const count = state[HEADER.bodyCount] as number;
  const out: ArcadeEffect[] = [];
  for (let i = 0; i < count; i += 1) {
    if (roleAt(state, i) !== a || !isAlive(state, i)) continue;
    for (let j = 0; j < count; j += 1) {
      if (j === i || roleAt(state, j) !== b || !isAlive(state, j)) continue;
      if (gap(state, i, j) > 0 || !overlapsY(state, i, j)) continue;
      out.push(...evaluate(ctx, rule, i, j));
    }
  }
  return out;
}

function overlapsY(state: Int32Array, a: number, b: number): boolean {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  // Obrysy se musí opravdu překrývat, dotyk hranou nestačí (jako `overlaps` v jádře).
  if (Math.abs((state[pa + BODY.x] as number) - (state[pb + BODY.x] as number)) * 2 >= (state[pa + BODY.w] as number) + (state[pb + BODY.w] as number)) return false;
  if (Math.abs((state[pa + BODY.z] as number) - (state[pb + BODY.z] as number)) * 2 >= (state[pa + BODY.d] as number) + (state[pb + BODY.d] as number)) return false;
  return (state[pa + BODY.y] as number) < (state[pb + BODY.y] as number) + (state[pb + BODY.h] as number) && (state[pb + BODY.y] as number) < (state[pa + BODY.y] as number) + (state[pa + BODY.h] as number);
}

function makePiece(id: string, trigger: RuleTrigger, fire: (ctx: RuleContext, rule: CompiledRule) => readonly ArcadeEffect[]): RulePiece<CompiledRule> {
  return { id, params: compiledRuleSchema, roles: ['player'], trigger, cost: () => ({ bodies: 0, rules: 1 }), fire };
}

/** Kusy, na které se pravidla ze specu překládají – patří do `ARCADE_LIBRARY`. */
export const SPEC_RULES = {
  rule_contact: makePiece('rule_contact', 'contact', (ctx, rule) => {
    if (!('contact' in rule.when) || roleAt(ctx.state, ctx.other) !== rule.when.contact[1]) return [];
    return evaluate(ctx, rule, ctx.player, ctx.other);
  }),
  rule_press: makePiece('rule_press', 'press', (ctx, rule) => ('press' in rule.when && (ctx.input.buttons & rule.when.press) !== 0 ? evaluate(ctx, rule, -1, -1) : [])),
  rule_tick: makePiece('rule_tick', 'tick', (ctx, rule) => {
    if ('contact' in rule.when) return pairContacts(ctx, rule, rule.when.contact[0], rule.when.contact[1]);
    if ('every' in rule.when) return ((ctx.state[HEADER.tick] as number) + 1) % rule.when.every === 0 ? evaluate(ctx, rule, -1, -1) : [];
    return [];
  }),
  rule_counter: makePiece('rule_counter', 'counter', (ctx, rule) =>
    'counter' in rule.when && counterValue(ctx.state, rule.when.counter.name) >= rule.when.counter.atLeast ? evaluate(ctx, rule, -1, -1) : [],
  ),
  rule_hit: makePiece('rule_hit', 'hit', (ctx, rule) => ('hit' in rule.when && ctx.other >= 0 && roleAt(ctx.state, ctx.other) === rule.when.hit ? evaluate(ctx, rule, ctx.source, ctx.other) : [])),
} as const;

// ---------------------------------------------------------------------------
// Role → kódy a věci

/** Druh role ve specu → role jádra, kterou generátory staví (v pořadí přednosti). */
const KIND_ROLES: Partial<Readonly<Record<RoleKind, readonly ArcadeRole[]>>> = {
  collectible: ['collectible'],
  exit: ['goal'],
  destination: ['goal'],
  checkpoint: ['checkpoint'],
  target: ['target'],
  hazard: ['hazard', 'obstacle', 'enemy'],
  chaser: ['chaser', 'enemy'],
  patrol: ['enemy'],
};

/** Obrys věci podle druhu role: [šířka, výška, hloubka] v jednotkách, pevná? */
const THING_SHAPE: Readonly<Record<RoleKind, readonly [number, number, number, boolean]>> = {
  player: [1000, 600, 1000, false],
  key: [500, 500, 500, false],
  item: [600, 600, 600, false],
  collectible: [500, 500, 500, false],
  door: [2000, 2500, 500, true],
  switch: [1500, 100, 1500, false],
  checkpoint: [1500, 100, 1500, false],
  zone: [3000, 100, 3000, false],
  destination: [1500, 2000, 1500, false],
  exit: [1500, 2000, 1500, false],
  target: [1200, 1500, 1200, false],
  prop: [1000, 1000, 1000, true],
  hazard: [1500, 200, 1500, false],
  chaser: [800, 1600, 800, false],
  patrol: [800, 1600, 800, false],
};

/** Role, na které pravidla a `things` odkazují (bez hráče), v pořadí `roles[]`. */
function referencedRoles(spec: GameSpecV1): string[] {
  const names = new Set<string>();
  for (const rule of spec.rules ?? []) {
    if ('contact' in rule.when) rule.when.contact.forEach((role) => names.add(role));
    if ('hit' in rule.when) names.add(rule.when.hit);
    for (const cond of rule.if ?? []) {
      if ('holding' in cond) names.add(cond.holding);
      if ('near' in cond) names.add(cond.near.role);
    }
    for (const effect of rule.do) {
      if ('spawn' in effect) names.add(effect.spawn.role);
      if ('toggle' in effect) names.add(effect.toggle);
    }
  }
  for (const thing of spec.things ?? []) names.add(thing.role);
  return spec.roles.filter((role) => role.kind !== 'player' && names.has(role.id)).map((role) => role.id);
}

/** Jméno role → kód jádra. Hráč pod `player` i pod id své role. */
export function roleCodes(spec: GameSpecV1, level: ArcadeLevel): Map<string, number> {
  const codes = new Map<string, number>([['player', ROLE.player]]);
  for (const role of spec.roles) if (role.kind === 'player') codes.set(role.id, ROLE.player);
  const present = new Set(level.bodies.map((body) => ROLE[body.role]));
  let next = THING_ROLE_BASE;
  for (const id of referencedRoles(spec)) {
    const role = spec.roles.find((r) => r.id === id)!;
    const reuse = (KIND_ROLES[role.kind] ?? []).find((name) => present.has(ROLE[name]));
    codes.set(id, reuse === undefined ? next++ : ROLE[reuse]);
  }
  return codes;
}

/** Pravidla vyhrávají sama a ovládání je volný pohyb → hraje se na dvorku. */
export function rulesOwnGoal(spec: GameSpecV1): boolean {
  return spec.control === 'move_free' && (spec.rules ?? []).some((rule) => rule.do.some((effect) => 'win' in effect));
}

export const YARD = {
  half: 12 * UNIT,
  startZ: -8 * UNIT,
  wallZ: 2 * UNIT,
  wallDepth: 500,
  wallHeight: 1500,
  gapWidth: 2000,
  frontZ: [-5 * UNIT, -2 * UNIT] as const,
  backZ: 7 * UNIT,
  slotsX: [-6 * UNIT, -3 * UNIT, 0, 3 * UNIT, 6 * UNIT] as const,
} as const;

/** Dvorek: jen hráč, věci rozmístí `compileRules`. Pravidla základu žádná, kromě konce životů. */
export function yardParts(health: number | undefined): ArcadeParts {
  const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: YARD.startZ, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false };
  return {
    control: { id: 'move_free', params: { half: YARD.half } },
    bot: { id: 'arena_bot', params: { half: YARD.half } },
    level: { bodies: [player], length: 0 },
    rules: health === undefined ? [] : [{ id: 'out_of_health', params: {} }],
  };
}

/** Role, na které míří `grab` / `push` – nosí se a strkají, takže nepatří za zeď. */
function moverRoles(rules: readonly Rule[]): Set<string> {
  const movers = new Set<string>();
  for (const rule of rules) {
    const contact = 'contact' in rule.when ? rule.when.contact : null;
    const near = (rule.if ?? []).find((cond): cond is Extract<RuleIf, { near: unknown }> => 'near' in cond)?.near.role;
    for (const effect of rule.do) {
      const which = 'grab' in effect ? effect.grab : 'push' in effect ? effect.push : null;
      if (which === 'self' && contact !== null) movers.add(contact[0]);
      if (which === 'other') {
        const other = contact?.[1] ?? near;
        if (other !== undefined) movers.add(other);
      }
    }
  }
  return movers;
}

/** Role, kterých se týká výherní pravidlo – cíl cesty. */
function goalRoles(rules: readonly Rule[]): Set<string> {
  const goals = new Set<string>();
  for (const rule of rules) {
    if (!rule.do.some((effect) => 'win' in effect)) continue;
    if ('contact' in rule.when) rule.when.contact.forEach((role) => goals.add(role));
    if ('hit' in rule.when) goals.add(rule.when.hit);
  }
  for (const mover of moverRoles(rules)) goals.delete(mover);
  goals.delete('player');
  return goals;
}

const toggled = (rules: readonly Rule[]): Set<string> => new Set(rules.flatMap((rule) => rule.do.flatMap((effect: RuleDo) => ('toggle' in effect ? [effect.toggle] : []))));

export interface RulesCompiled {
  readonly rules: PieceRef[];
  readonly level: ArcadeLevel;
}

/** Pravidlo ze specu → `PieceRef` (kódy místo jmen); `templates` = role → index předlohy. */
function compileRule(rule: Rule, codes: ReadonlyMap<string, number>, templates: ReadonlyMap<string, number>): PieceRef {
  const c = (name: string): number => codes.get(name) as number;
  let when: CompiledRule['when'];
  let id: keyof typeof SPEC_RULES;
  if ('contact' in rule.when) {
    const [a, b] = rule.when.contact;
    // Hráč vždy první: jádro hlásí jen kontakty hráče a `other` je to druhé tělo.
    const pair: [number, number] = c(b) === ROLE.player ? [c(b), c(a)] : [c(a), c(b)];
    when = { contact: pair };
    id = pair[0] === ROLE.player ? 'rule_contact' : 'rule_tick';
  } else if ('press' in rule.when) {
    when = { press: rule.when.press === 'action' ? BUTTON.TAP : BUTTON.FIRE };
    id = 'rule_press';
  } else if ('every' in rule.when) {
    when = { every: rule.when.every };
    id = 'rule_tick';
  } else if ('counter' in rule.when) {
    when = { counter: rule.when.counter };
    id = 'rule_counter';
  } else {
    when = { hit: c(rule.when.hit) };
    id = 'rule_hit';
  }
  const conditions: CompiledIf[] = (rule.if ?? []).map((cond) => {
    if ('holding' in cond) return { holding: c(cond.holding) };
    if ('near' in cond) return { near: { role: c(cond.near.role), within: cond.near.within * UNIT } };
    return cond;
  });
  const effects: CompiledDo[] = rule.do.map((effect) => {
    if ('spawn' in effect) return { spawn: { template: templates.get(effect.spawn.role) as number, at: effect.spawn.at } };
    if ('toggle' in effect) return { toggle: c(effect.toggle) };
    return effect;
  });
  const params: CompiledRule = { id: rule.id, verb: rule.verb, when, if: conditions, do: effects };
  return { id, params };
}

/**
 * Pravidla specu → kusy jádra a úroveň s věcmi pravidel. Bez pravidel vrací
 * úroveň beze změny a žádný kus (hash dnešních her se nepohne).
 */
export function compileRules(spec: GameSpecV1, level: ArcadeLevel, seed: number): RulesCompiled {
  const rules = spec.rules ?? [];
  if (rules.length === 0 && (spec.things ?? []).length === 0) return { rules: [], level };
  const codes = roleCodes(spec, level);
  const yard = rulesOwnGoal(spec);
  const hidden = new Set((spec.things ?? []).filter((thing) => thing.start === 'hidden').map((thing) => thing.role));
  const gates = toggled(rules);
  const goals = goalRoles(rules);
  const rng = createCompileRng(seed ^ 0x5eed);
  const bodies: BodyInit[] = [...level.bodies];
  const start = bodies[0]!;

  const things = referencedRoles(spec).filter((id) => (codes.get(id) as number) >= THING_ROLE_BASE);
  const thingBody = (id: string, x: number, z: number, extra: Partial<BodyInit> = {}): BodyInit => {
    const role = spec.roles.find((r) => r.id === id)!;
    const [w, h, d, solid] = THING_SHAPE[role.kind];
    return { role: 'thing', roleCode: codes.get(id) as number, kind: `thing:${id}`, x, y: 0, z, w, h, d, solid, ...(hidden.has(id) ? { template: true } : {}), ...extra };
  };
  const countOf = (id: string): number => Math.min(THING_MAX_COUNT, spec.roles.find((r) => r.id === id)?.count ?? 1);

  if (yard) {
    const wall = things.some((id) => gates.has(id) && !hidden.has(id));
    const gapX = rng.pick(YARD.slotsX);
    if (wall) {
      const left = -YARD.half;
      const right = YARD.half;
      const gapLeft = gapX - YARD.gapWidth / 2;
      const gapRight = gapX + YARD.gapWidth / 2;
      for (const [from, to] of [
        [left, gapLeft],
        [gapRight, right],
      ] as const) {
        if (to - from <= 0) continue;
        bodies.push({ role: 'obstacle', kind: 'fence', x: Math.trunc((from + to) / 2), y: 0, z: YARD.wallZ, w: to - from, h: YARD.wallHeight, d: YARD.wallDepth, solid: true });
      }
    }
    const front = rng.shuffle(YARD.frontZ.flatMap((z) => YARD.slotsX.map((x) => ({ x, z }))));
    const back = rng.shuffle(YARD.slotsX.map((x) => ({ x, z: YARD.backZ })));
    for (const id of things) {
      for (let k = 0; k < countOf(id); k += 1) {
        if (gates.has(id) && wall) bodies.push(thingBody(id, gapX, YARD.wallZ));
        else if (goals.has(id)) {
          const slot = back.shift() ?? { x: 0, z: YARD.backZ };
          bodies.push(thingBody(id, slot.x, slot.z));
        } else {
          const slot = front.shift() ?? { x: 0, z: YARD.frontZ[0] };
          bodies.push(thingBody(id, slot.x, slot.z));
        }
      }
    }
  } else {
    // Mimo dvorek věci stojí před hráčem po směru trati; hratelnost rozhodne robot.
    let k = 0;
    for (const id of things) {
      for (let n = 0; n < countOf(id); n += 1, k += 1) bodies.push(thingBody(id, start.x, start.z + 8 * UNIT + 4 * UNIT * k));
    }
  }

  const templates = new Map<string, number>();
  for (const rule of rules) {
    for (const effect of rule.do) {
      if (!('spawn' in effect) || templates.has(effect.spawn.role)) continue;
      const id = effect.spawn.role;
      const role = spec.roles.find((r) => r.id === id)!;
      const [w, h, d, solid] = THING_SHAPE[role.kind];
      const roleCode = codes.get(id) as number;
      templates.set(id, bodies.length);
      bodies.push({ role: 'thing', roleCode, kind: `thing:${id}`, x: 0, y: 0, z: 0, w, h, d, solid, template: true });
    }
  }
  const spawnSlots = templates.size > 0 ? Math.min((level.spawnSlots ?? 0) + RULE_SPAWN_SLOTS, ARCADE_LIMITS.maxBodies - bodies.length) : level.spawnSlots;
  return {
    rules: rules.map((rule) => compileRule(rule, codes, templates)),
    level: { ...level, bodies, ...(spawnSlots === undefined ? {} : { spawnSlots }) },
  };
}
