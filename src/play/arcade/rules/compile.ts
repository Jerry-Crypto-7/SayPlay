/**
 * Překlad pravidel ze specu na kusy jádra (P29A, T2).
 *
 * Pravidlo z `rules/schema.ts` mluví jmény rolí; jádro čísly. Překlad:
 *
 * 1. **Role → kód.** Hráč je `ROLE.player`. Role, jejíž druh už základní
 *    úroveň staví (mince běžce = `collectible`), dostane kód toho druhu – pravidlo
 *    pak míří na tělesa generátoru. Ostatní role jsou **věci pravidel**: kód
 *    `THING_ROLE_BASE + k` a tělesa, která překlad sám rozmístí.
 * 2. **Pravidlo → `PieceRef`** na jeden z kusů podle spouštěče
 *    (`rule_contact`, `rule_press`, `rule_tick`, `rule_counter`, `rule_hit`; logika
 *    P45B `rule_timer`, `rule_phase`, `rule_event`) s parametry, ve kterých už jsou
 *    kódy místo jmen rolí a indexy místo jmen logiky. Jádro je spouští stejně jako
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
  FIRED,
  FLAG,
  HEADER,
  HIT_GRACE,
  LOGIC_BODIES,
  LOGIC_LIMITS,
  LOGIC_SLOTS,
  type PieceRef,
  ROLE,
  type RuleContext,
  type RulePiece,
  type RuleTrigger,
  UNIT,
  bodyBase,
  firedBit,
  logicBase,
  phaseOf,
  timerLeft,
  varValue,
} from '../contract';
import type { LogicInit } from '../kernel';
import { ARENA } from '../pieces/arena';
import { compiledInteractWhen, interactFire } from './interact';
import { type Logic, RULE_COUNTERS, type Rule, type RuleDo, type RuleIf } from './schema';

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

// Logika (P45B): jména z bloku `logic` jako indexy v pořadí deklarace.
const varIndex = z.int().min(0).max(LOGIC_LIMITS.maxVars - 1);
const timerIndex = z.int().min(0).max(LOGIC_LIMITS.maxTimers - 1);
const phaseIndex = z.int().min(0).max(LOGIC_LIMITS.maxPhases - 1);
const eventIndex = z.int().min(0).max(LOGIC_LIMITS.maxEvents - 1);
const varBound = { index: varIndex, atLeast: z.int().optional(), below: z.int().optional() };

const compiledWhen = z.union([
  z.object({ contact: z.tuple([code, code]) }).strict(),
  z.object({ press: z.int().min(1) }).strict(),
  z.object({ every: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict(),
  z.object({ counter: z.object({ name: counterName, atLeast: z.int() }).strict() }).strict(),
  z.object({ hit: code }).strict(),
  compiledInteractWhen,
  z.object({ timer: timerIndex }).strict(),
  z.object({ phase: phaseIndex }).strict(),
  z.object({ phaseExit: phaseIndex }).strict(),
  /** `latch` = bit západky ve `varLatch`: index pravidla ve specu (pravidel je nejvýš 16). */
  z.object({ var: z.object({ ...varBound, latch: z.int().min(0).max(ARCADE_LIMITS.maxRules - 1) }).strict() }).strict(),
  z.object({ event: eventIndex }).strict(),
]);

const compiledIf = z.union([
  z.object({ holding: code }).strict(),
  z.object({ notHolding: z.literal(true) }).strict(),
  z.object({ counter: z.object({ name: counterName, atLeast: z.int().optional(), below: z.int().optional() }).strict() }).strict(),
  /** `within` už v jednotkách jádra. */
  z.object({ near: z.object({ role: code, within: z.int().min(0) }).strict() }).strict(),
  z.object({ var: z.object(varBound).strict() }).strict(),
  z.object({ inPhase: phaseIndex }).strict(),
  z.object({ timerRunning: timerIndex }).strict(),
  z.object({ timerStopped: timerIndex }).strict(),
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
  z.object({ set: z.object({ var: varIndex, value: z.int() }).strict() }).strict(),
  z.object({ add: z.object({ var: varIndex, amount: z.int() }).strict() }).strict(),
  z.object({ goPhase: phaseIndex }).strict(),
  z.object({ startTimer: z.object({ timer: timerIndex, ticks: z.int().min(1).max(ARCADE_LIMITS.maxTicks) }).strict() }).strict(),
  z.object({ stopTimer: timerIndex }).strict(),
  z.object({ emit: eventIndex }).strict(),
  /** `template` = index předlohy ve světě; `floor` = polovina strany podlahy (dvorek, aréna), když ji svět má – `edge` ji má vždy. */
  z
    .object({
      wave: z
        .object({ template: z.int().min(0), count: z.int().min(1).max(LOGIC_LIMITS.maxWave), at: z.enum(['edge', 'player', 'other']), floor: z.int().min(1).optional() })
        .strict(),
    })
    .strict(),
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

/** Hodnota v mezi `atLeast` / `below` (`ruleIssues` u proměnné hlídá právě jednu). */
const inBound = (value: number, bound: { readonly atLeast?: number | undefined; readonly below?: number | undefined }): boolean =>
  (bound.atLeast === undefined || value >= bound.atLeast) && (bound.below === undefined || value < bound.below);

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
    } else if ('var' in cond) {
      // Podmínky logiky mají jen pravidla světa s logikou, takže logická těla tu jsou.
      if (!inBound(varValue(state, logicBase(state), cond.var.index), cond.var)) return -2;
    } else if ('inPhase' in cond) {
      if (phaseOf(state, logicBase(state)) !== cond.inPhase) return -2;
    } else if ('timerRunning' in cond) {
      if (timerLeft(state, logicBase(state), cond.timerRunning) === 0) return -2;
    } else if ('timerStopped' in cond) {
      if (timerLeft(state, logicBase(state), cond.timerStopped) !== 0) return -2;
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
    else if ('damage' in effect) {
      // Milost po zásahu jako u zásahů jádra (P36A F1) – jen ve hře se životy: hra bez nich má
      // čítač 0 (`buildWorld`), zásah tam milost nepotřebuje a stav se nepohne proti dřívějšku.
      const lives = (state[HEADER.counters + COUNTER.health] as number) > 0;
      out.push(lives ? { kind: 'damage', amount: effect.damage, grace: HIT_GRACE } : { kind: 'damage', amount: effect.damage });
    }
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
    else if ('set' in effect) out.push({ kind: 'setVar', var: effect.set.var, value: effect.set.value });
    else if ('add' in effect) out.push({ kind: 'addVar', var: effect.add.var, amount: effect.add.amount });
    else if ('goPhase' in effect) out.push({ kind: 'goPhase', phase: effect.goPhase });
    else if ('startTimer' in effect) out.push({ kind: 'startTimer', timer: effect.startTimer.timer, ticks: effect.startTimer.ticks });
    else if ('stopTimer' in effect) out.push({ kind: 'stopTimer', timer: effect.stopTimer });
    else if ('emit' in effect) out.push({ kind: 'emit', event: effect.emit });
    else if ('wave' in effect) out.push(...waveSpawns(state, player, other, effect.wave));
    else out.push({ kind: 'toggle', role: effect.toggle });
  }
  return out;
}

/** Míst po obvodu podlahy, ze kterých vybírá vlna `edge`. */
export const WAVE_EDGE_SLOTS = 32;
/** Poloměr kruhu vlny `player` / `other` (střed ke středu). */
export const WAVE_RING = 3 * UNIT;
/** Odstup těla vlny od okraje podlahy a od hráče. */
export const WAVE_GAP = UNIT / 2;
/** cos po 22,5° × 1000 – pevná tabulka, ne `Math.cos`: kruh vyjde všude bit po bitu stejně. */
const RING_COS = [1000, 924, 707, 383, 0, -383, -707, -924, -1000, -924, -707, -383, 0, 383, 707, 924] as const;

type CompiledWave = Extract<CompiledDo, { wave: unknown }>['wave'];

/** Místo `s` z `slots` po obvodu čtverce podlahy vsazeného o půl těla a odstup: od rohu −x/−z po +x, pak +z, −x, −z. */
function edgeSpot(half: number, size: number, s: number, slots: number): { x: number; z: number } {
  const e = half - Math.ceil(size / 2) - WAVE_GAP;
  const along = Math.floor((s * 8 * e) / slots);
  const side = Math.floor(along / (2 * e));
  const run = along - side * 2 * e;
  if (side === 0) return { x: -e + run, z: -e };
  if (side === 1) return { x: e, z: -e + run };
  if (side === 2) return { x: e - run, z: e };
  return { x: -e, z: e - run };
}

/**
 * Vlna (`wave`) → nejvýš `count` efektů `spawn` z předlohy. Místa leží rovnoměrně po obvodu
 * podlahy (`edge`, `WAVE_EDGE_SLOTS`) nebo po kruhu `WAVE_RING` kolem hráče / těla `other`
 * (16 směrů); i-té tělo začne na místě `i · míst / count`. Místo ve zdi (živé pevné tělo), u
 * hráče blíž než `WAVE_GAP` nebo mimo podlahu přeskočí na další volné; kde volné není, tělo
 * nevznikne. Žádná náhoda: pozice jsou jen ze stavu a indexu.
 */
function waveSpawns(state: Int32Array, player: number, other: number, wave: CompiledWave): ArcadeEffect[] {
  const center = wave.at === 'player' ? player : other;
  if (wave.at !== 'edge' && center < 0) return [];
  const t = bodyBase(wave.template);
  const w = state[t + BODY.w] as number;
  const d = state[t + BODY.d] as number;
  const slots = wave.at === 'edge' ? WAVE_EDGE_SLOTS : RING_COS.length;
  const c = bodyBase(center);
  const spot = (s: number): { x: number; z: number } =>
    wave.at === 'edge'
      ? edgeSpot(wave.floor as number, Math.max(w, d), s, slots)
      : {
          x: (state[c + BODY.x] as number) + Math.trunc((RING_COS[s]! * WAVE_RING) / 1000),
          // sin = cos o čtvrt kruhu dřív.
          z: (state[c + BODY.z] as number) + Math.trunc((RING_COS[(s + 12) % 16]! * WAVE_RING) / 1000),
        };
  const count = state[HEADER.bodyCount] as number;
  const free = (x: number, z: number): boolean => {
    if (wave.floor !== undefined && (Math.abs(x) * 2 + w > wave.floor * 2 || Math.abs(z) * 2 + d > wave.floor * 2)) return false;
    for (let i = 0; i < count; i += 1) {
      const b = bodyBase(i);
      if (i !== player && ((state[b + BODY.flags] as number) & (FLAG.alive | FLAG.solid)) !== (FLAG.alive | FLAG.solid)) continue;
      const gap = i === player ? 2 * WAVE_GAP : 0;
      if (Math.abs(x - (state[b + BODY.x] as number)) * 2 < w + (state[b + BODY.w] as number) + gap && Math.abs(z - (state[b + BODY.z] as number)) * 2 < d + (state[b + BODY.d] as number) + gap) return false;
    }
    return true;
  };
  const out: ArcadeEffect[] = [];
  let taken = 0;
  for (let i = 0; i < wave.count; i += 1) {
    const first = Math.floor((i * slots) / wave.count);
    for (let k = 0; k < slots; k += 1) {
      const s = (first + k) % slots;
      if (((taken >>> s) & 1) === 1) continue;
      const { x, z } = spot(s);
      if (!free(x, z)) continue;
      taken |= 1 << s;
      out.push({ kind: 'spawn', template: wave.template, x, y: 0, z, vx: 0, vy: 0, vz: 0 });
      break;
    }
  }
  return out;
}

/** Jedno vyhodnocení: podmínky, pak efekty. `other` −1, když spouštěč tělo nemá. */
function evaluate(ctx: RuleContext, rule: CompiledRule, self: number, other: number): readonly ArcadeEffect[] {
  const picked = check(ctx.state, ctx.player, rule.if, other);
  if (picked === -2) return [];
  return effectsOf(ctx, rule, self, picked);
}

/** Nejvýš tolik pravidel smí hlídat kontakt dvou věcí bez hráče (sken dvojic běží každý tik). */
export const PAIR_RULES_MAX = 4;
/**
 * Nejvýš tolik dvojic prověří jedno pravidlo za tik (pořadí podle indexu, deterministicky).
 * Dvojice za stropem se nekontrolují nikdy – každý tik začíná od stejných indexů;
 * robot ověřuje, co se opravdu stane, takže to hru nezfalšuje, jen pravidlo dělá méně.
 */
export const PAIR_CHECKS_MAX = 1024;

/** Kontakt dvou věcí bez hráče: dvojice živých těl rolí `a`×`b`, která se překrývají, do stropu `PAIR_CHECKS_MAX`. */
function pairContacts(ctx: RuleContext, rule: CompiledRule, a: number, b: number): ArcadeEffect[] {
  const { state } = ctx;
  const count = state[HEADER.bodyCount] as number;
  const as: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!isAlive(state, i)) continue;
    if (roleAt(state, i) === a) as.push(i);
    if (roleAt(state, i) === b) bs.push(i);
  }
  const out: ArcadeEffect[] = [];
  let checks = 0;
  for (const i of as) {
    for (const j of bs) {
      if (j === i) continue;
      if (checks++ >= PAIR_CHECKS_MAX) return out;
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

/** Vystřelil v tomto průchodu logiky bit `FIRED.<druh> + index`? Jen v průchodech logiky (`timer`, `phase`, `event`). */
const logicFired = (ctx: RuleContext, bit: number): boolean => firedBit(ctx.state, logicBase(ctx.state), bit);

type VarWhen = Extract<CompiledRule['when'], { var: unknown }>['var'];

/**
 * Překročení meze proměnné (`when.var`) v průchodu čítačů: vystřelí, jakmile je proměnná v mezi a
 * podmínky platí, a zaklapne západku (bit `latch` ve `varLatch`); znovu až poté, co proměnná z meze
 * vyjde a západka se uvolní.
 */
function crossing(ctx: RuleContext, rule: CompiledRule, bound: VarWhen): readonly ArcadeEffect[] {
  const base = logicBase(ctx.state);
  const inside = inBound(varValue(ctx.state, base, bound.index), bound);
  const latched = (((ctx.state[base + LOGIC_SLOTS.varLatch] as number) >>> bound.latch) & 1) === 1;
  if (!inside) return latched ? [{ kind: 'latch', bit: bound.latch, on: false }] : [];
  if (latched) return [];
  const picked = check(ctx.state, ctx.player, rule.if, -1);
  if (picked === -2) return [];
  // Západka první: utne-li strop efektů tiku zbytek, nevystřelí pravidlo ani podruhé.
  return [{ kind: 'latch', bit: bound.latch, on: true }, ...effectsOf(ctx, rule, -1, picked)];
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
  rule_counter: makePiece('rule_counter', 'counter', (ctx, rule) => {
    if ('var' in rule.when) return crossing(ctx, rule, rule.when.var);
    return 'counter' in rule.when && counterValue(ctx.state, rule.when.counter.name) >= rule.when.counter.atLeast ? evaluate(ctx, rule, -1, -1) : [];
  }),
  rule_hit: makePiece('rule_hit', 'hit', (ctx, rule) => ('hit' in rule.when && ctx.other >= 0 && roleAt(ctx.state, ctx.other) === rule.when.hit ? evaluate(ctx, rule, ctx.source, ctx.other) : [])),
  // Tělo pravidla je v `interact.ts` (P32G); `do` se vyhodnotí pro cíl, který došel do konečného stavu.
  interact: makePiece('interact', 'press', (ctx, rule) => ('interact' in rule.when ? interactFire(ctx, rule.when.interact, (body) => evaluate(ctx, rule, ctx.player, body)) : [])),
  // Logika (P45B): průchody jádra za průchodem čítačů; co vystřelilo, nese `LOGIC_SLOTS.fired`.
  rule_timer: makePiece('rule_timer', 'timer', (ctx, rule) => ('timer' in rule.when && logicFired(ctx, FIRED.timer + rule.when.timer) ? evaluate(ctx, rule, -1, -1) : [])),
  rule_phase: makePiece('rule_phase', 'phase', (ctx, rule) => {
    if ('phase' in rule.when) return logicFired(ctx, FIRED.phaseEnter + rule.when.phase) ? evaluate(ctx, rule, -1, -1) : [];
    return 'phaseExit' in rule.when && logicFired(ctx, FIRED.phaseExit + rule.when.phaseExit) ? evaluate(ctx, rule, -1, -1) : [];
  }),
  rule_event: makePiece('rule_event', 'event', (ctx, rule) => ('event' in rule.when && logicFired(ctx, FIRED.event + rule.when.event) ? evaluate(ctx, rule, -1, -1) : [])),
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
    if ('interact' in rule.when) names.add(rule.when.interact.role);
    for (const cond of rule.if ?? []) {
      if ('holding' in cond) names.add(cond.holding);
      if ('near' in cond) names.add(cond.near.role);
    }
    for (const effect of rule.do) {
      if ('spawn' in effect) names.add(effect.spawn.role);
      if ('wave' in effect) names.add(effect.wave.role);
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
  /** Co spec chce a tenhle svět neumí – jde režisérovi do opravného kola jako `WORLD_REJECTED`. */
  readonly issues: string[];
  /** Počátek logiky pro `buildWorld` (P45B), jen u specu s blokem `logic`. */
  readonly logic?: LogicInit;
}

/** Jméno role jádra ke kódu pod `THING_ROLE_BASE`. */
const builtinRole = (code: number): ArcadeRole => (Object.keys(ROLE) as ArcadeRole[]).find((name) => ROLE[name] === code) as ArcadeRole;

/** Jména bloku `logic` podle druhu v pořadí deklarace – index jména je jeho index v jádře. */
interface LogicNames {
  readonly var: readonly string[];
  readonly timer: readonly string[];
  readonly phase: readonly string[];
  readonly event: readonly string[];
}

const logicNames = (logic: Logic | undefined): LogicNames => ({
  var: (logic?.vars ?? []).map((entry) => entry.id),
  timer: (logic?.timers ?? []).map((entry) => entry.id),
  phase: (logic?.phases ?? []).map((entry) => entry.id),
  event: logic?.events ?? [],
});

/**
 * Pravidlo ze specu → `PieceRef` (kódy místo jmen rolí, indexy místo jmen logiky); `index` = pořadí
 * pravidla ve specu (bit západky), `templates` = role → index předlohy, `floor` = polovina strany podlahy.
 */
function compileRule(rule: Rule, index: number, codes: ReadonlyMap<string, number>, templates: ReadonlyMap<string, number>, names: LogicNames, floor: number | undefined): PieceRef {
  const c = (name: string): number => codes.get(name) as number;
  // `ruleIssues` pustí jen deklarovaná jména, takže index vždy je.
  const v = (name: string): number => names.var.indexOf(name);
  const t = (name: string): number => names.timer.indexOf(name);
  const p = (name: string): number => names.phase.indexOf(name);
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
  } else if ('interact' in rule.when) {
    const { role, radius, ...rest } = rule.when.interact;
    when = { interact: { role: c(role), radius: radius * UNIT, ...rest } };
    id = 'interact';
  } else if ('hit' in rule.when) {
    when = { hit: c(rule.when.hit) };
    id = 'rule_hit';
  } else if ('timer' in rule.when) {
    when = { timer: t(rule.when.timer) };
    id = 'rule_timer';
  } else if ('phase' in rule.when) {
    when = { phase: p(rule.when.phase) };
    id = 'rule_phase';
  } else if ('phaseExit' in rule.when) {
    when = { phaseExit: p(rule.when.phaseExit) };
    id = 'rule_phase';
  } else if ('var' in rule.when) {
    const { name, ...bound } = rule.when.var;
    // Překročení meze hlídá průchod čítačů; západka je bit pravidla v logickém těle.
    when = { var: { index: v(name), ...bound, latch: index } };
    id = 'rule_counter';
  } else {
    when = { event: names.event.indexOf(rule.when.event) };
    id = 'rule_event';
  }
  const conditions: CompiledIf[] = (rule.if ?? []).map((cond) => {
    if ('holding' in cond) return { holding: c(cond.holding) };
    if ('near' in cond) return { near: { role: c(cond.near.role), within: cond.near.within * UNIT } };
    if ('var' in cond) {
      const { name, ...bound } = cond.var;
      return { var: { index: v(name), ...bound } };
    }
    if ('inPhase' in cond) return { inPhase: p(cond.inPhase) };
    if ('timerRunning' in cond) return { timerRunning: t(cond.timerRunning) };
    if ('timerStopped' in cond) return { timerStopped: t(cond.timerStopped) };
    return cond;
  });
  const effects: CompiledDo[] = rule.do.map((effect) => {
    if ('spawn' in effect) return { spawn: { template: templates.get(effect.spawn.role) as number, at: effect.spawn.at } };
    if ('toggle' in effect) return { toggle: c(effect.toggle) };
    if ('set' in effect) return { set: { var: v(effect.set.var), value: effect.set.value } };
    if ('add' in effect) return { add: { var: v(effect.add.var), amount: effect.add.amount } };
    if ('goPhase' in effect) return { goPhase: p(effect.goPhase) };
    if ('startTimer' in effect) return { startTimer: { timer: t(effect.startTimer.timer), ticks: effect.startTimer.ticks } };
    if ('stopTimer' in effect) return { stopTimer: t(effect.stopTimer) };
    if ('emit' in effect) return { emit: names.event.indexOf(effect.emit) };
    if ('wave' in effect) {
      const { role, count, at } = effect.wave;
      return { wave: { template: templates.get(role) as number, count, at, ...(floor === undefined ? {} : { floor }) } };
    }
    return effect;
  });
  const params: CompiledRule = { id: rule.id, verb: rule.verb, when, if: conditions, do: effects };
  return { id, params };
}

/**
 * Pravidla specu → kusy jádra a úroveň s věcmi pravidel. Bez pravidel vrací
 * úroveň beze změny a žádný kus (hash dnešních her se nepohne). `floor` = polovina
 * strany podlahy ovládání volného pohybu (dvorek, aréna) – bez ní vlna `edge` nemá kde stát.
 */
export function compileRules(spec: GameSpecV1, level: ArcadeLevel, seed: number, floor?: number): RulesCompiled {
  const rules = spec.rules ?? [];
  if (rules.length === 0 && (spec.things ?? []).length === 0) return { rules: [], level, issues: [] };
  const codes = roleCodes(spec, level);
  const yard = rulesOwnGoal(spec);
  const hidden = new Set((spec.things ?? []).filter((thing) => thing.start === 'hidden').map((thing) => thing.role));
  // Skrytá může být jen věc pravidel: těleso generátoru stojí od začátku a `toggle` by ho schoval, ne odhalil.
  const issues = [...hidden]
    .filter((id) => (codes.get(id) as number) < THING_ROLE_BASE)
    .map((id) => `things: role "${id}" is built by the ${spec.control} game itself and is visible from the start, so start:"hidden" cannot apply – give the hidden thing its own role id and kind`);
  const pairs = rules.filter((rule) => 'contact' in rule.when && codes.get(rule.when.contact[0]) !== ROLE.player && codes.get(rule.when.contact[1]) !== ROLE.player).length;
  if (pairs > PAIR_RULES_MAX) issues.push(`rules: ${pairs} rules watch a contact between two things without the player; at most ${PAIR_RULES_MAX} may – merge them`);
  const waves = rules.flatMap((rule, index) => rule.do.flatMap((effect, i) => ('wave' in effect ? [{ ...effect.wave, path: `/rules/${index}/do/${i}/wave/at` }] : [])));
  if (floor === undefined) {
    for (const wave of waves.filter((w) => w.at === 'edge')) issues.push(`${wave.path}: "edge" needs a floor with edges (free movement in a yard or an arena) – use "player" or "other"`);
  }
  // Fyzikální věc (P29A T13): hýbe s ní Rapier. Jen věci pravidel – tělesa generátoru mají vlastní pohyb.
  const physical = new Set((spec.things ?? []).filter((thing) => thing.physics === true).map((thing) => thing.role));
  const physics = (id: string): Partial<BodyInit> => (physical.has(id) ? { physics: true } : {});
  const gates = toggled(rules);
  const goals = goalRoles(rules);
  const rng = createCompileRng(seed ^ 0x5eed);
  const bodies: BodyInit[] = [...level.bodies];
  const start = bodies[0]!;

  const things = referencedRoles(spec).filter((id) => (codes.get(id) as number) >= THING_ROLE_BASE);
  const thingBody = (id: string, x: number, z: number, extra: Partial<BodyInit> = {}): BodyInit => {
    const role = spec.roles.find((r) => r.id === id)!;
    const [w, h, d, solid] = THING_SHAPE[role.kind];
    return { role: 'thing', roleCode: codes.get(id) as number, kind: `thing:${id}`, x, y: 0, z, w, h, d, solid, ...(hidden.has(id) ? { template: true } : {}), ...physics(id), ...extra };
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

  // Předloha na roli, kterou rodí `spawn` nebo `wave`.
  const templates = new Map<string, number>();
  for (const rule of rules) {
    for (const effect of rule.do) {
      const id = 'spawn' in effect ? effect.spawn.role : 'wave' in effect ? effect.wave.role : undefined;
      if (id === undefined || templates.has(id)) continue;
      const role = spec.roles.find((r) => r.id === id)!;
      const [w, h, d, solid] = THING_SHAPE[role.kind];
      const roleCode = codes.get(id) as number;
      // Role jádra (mince → collectible) se rodí jako tělo té role, aby na ni platila pravidla dílků.
      const identity = roleCode < THING_ROLE_BASE ? { role: builtinRole(roleCode) } : { role: 'thing' as const, roleCode };
      templates.set(id, bodies.length);
      bodies.push({ ...identity, kind: `thing:${id}`, x: 0, y: 0, z: 0, w, h, d, solid, template: true, ...physics(id) });
    }
  }
  // Každá vlna smí stát celá najednou vedle rezervy spawnu; logická těla jdou za tělesy úrovně, ze stropu.
  const waveBodies = waves.reduce((sum, wave) => sum + wave.count, 0);
  const logicBodies = spec.logic === undefined ? 0 : LOGIC_BODIES;
  const spawnSlots =
    templates.size > 0 ? Math.min((level.spawnSlots ?? 0) + RULE_SPAWN_SLOTS + waveBodies, ARCADE_LIMITS.maxBodies - bodies.length - logicBodies) : level.spawnSlots;
  const names = logicNames(spec.logic);
  // Počátek logiky: proměnné na `start` (jinak 0), hra v počáteční fázi 0.
  const logic: LogicInit | undefined = spec.logic === undefined ? undefined : { vars: (spec.logic.vars ?? []).map((entry) => entry.start ?? 0), phases: names.phase.length };
  return {
    rules: rules.map((rule, index) => compileRule(rule, index, codes, templates, names, floor)),
    level: { ...level, bodies, ...(spawnSlots === undefined ? {} : { spawnSlots }) },
    issues,
    ...(logic === undefined ? {} : { logic }),
  };
}
