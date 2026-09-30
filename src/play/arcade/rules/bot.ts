/**
 * Robot pro hry z pravidel (P29A, T5): plánovač cílů nad pravidly specu.
 *
 * Robot arény jí a utíká; na dvorku, kde se vyhrává slovesy, by jen bloudil.
 * Tenhle robot jde od výherního pravidla pozpátku: co musí platit, aby
 * vystřelilo, a které pravidlo to zařídí. „Dotkni se schodů“ → schody jsou za
 * zdí a v bráně stojí dveře → dveře přepne pravidlo „dotkni se dveří s
 * klíčem“ → klíč zvedne pravidlo „dotkni se klíče“ → jdi ke klíči. Každý tik
 * plánuje znovu z toho, co vidí, takže si nic nepamatuje a nic mu neuteče.
 *
 * Umí slovesa jádra: dojít k věci (kontakt), nést (`grab`), hodit
 * (`throwHeld`), položit (`release`), strčit (`push`), stisknout (`press`),
 * nasbírat na čítač (`count`), držet Use u cíle (`interact`) a projít branou,
 * kterou otevře `toggle`.
 * Vidí jako robot arény svět o `reactionTicks` starší a svou polohu dopočítá.
 */

import {
  AXIS_MAX,
  type ArcadeCounter,
  type ArcadeInput,
  type ArcadeObservation,
  type ArcadeWorld,
  BODY,
  BUTTON,
  COUNTER,
  FLAG,
  HEADER,
  NO_INPUT,
  ROLE,
  bodyBase,
  targetStateOf,
} from '../contract';
import { ARENA, arenaAxis } from '../pieces/arena';
import { predict } from '../pieces/arena-bot';
import { type CompiledRule, SPEC_RULES, YARD, compiledRuleSchema, heldOf } from './compile';
import { type CompiledInteract, interactRecord, interactTarget, isLocked } from './interact';

/** Stejná reakce jako robot arény: věrohodný hráč nereaguje hned. */
const REACTION = 8;
/** Hloubka zpětného řetězení; hlubší plán robot nehledá. */
const MAX_DEPTH = 8;
/** Z jaké vzdálenosti (střed–střed) robot hází po cíli. */
const THROW_RANGE = 3000;
/** Rozběh před hodem, aby hráč mířil čistě po ose. */
const THROW_RUNUP = 1500;
/** Tolerance zarovnání na osu. */
const ALIGN = 300;

type Axis = 'x' | 'z';

type Action =
  | { readonly kind: 'move'; readonly x: number; readonly z: number; readonly arrive: boolean }
  /** Chůze čistě po ose (`dir` ±1) – hod a strkání potřebují přesný směr. */
  | { readonly kind: 'walk'; readonly axis: Axis; readonly dir: number; readonly buttons: number }
  | { readonly kind: 'press'; readonly buttons: number }
  | { readonly kind: 'wait' };

interface Body {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly vx: number;
  readonly vz: number;
}

interface Wall {
  readonly z: number;
  readonly gapX: number;
  readonly gapWidth: number;
}

interface View {
  readonly state: Int32Array;
  readonly player: number;
  readonly me: { readonly x: number; readonly z: number; readonly vx: number; readonly vz: number };
  readonly rules: readonly CompiledRule[];
  readonly wall: Wall | null;
}

const WAIT: Action = { kind: 'wait' };

function bodyAt(state: Int32Array, index: number): Body {
  const base = bodyBase(index);
  const v = (slot: keyof typeof BODY): number => state[base + BODY[slot]] as number;
  return { index, x: v('x'), z: v('z'), w: v('w'), h: v('h'), d: v('d'), vx: v('vx'), vz: v('vz') };
}

const flagsOf = (state: Int32Array, index: number): number => state[bodyBase(index) + BODY.flags] as number;
const roleOf = (state: Int32Array, index: number): number => state[bodyBase(index) + BODY.role] as number;
const aliveAt = (state: Int32Array, index: number): boolean => (flagsOf(state, index) & FLAG.alive) !== 0;

/** Nejbližší živé tělo role k bodu (mimo hráče a nesené tělo); shoda = nižší index. */
function nearestOf(view: View, role: number, from: { readonly x: number; readonly z: number } = view.me): Body | null {
  const { state } = view;
  const count = state[HEADER.bodyCount] as number;
  const held = heldOf(state);
  let best: Body | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    if (i === view.player || i === held || roleOf(state, i) !== role || !aliveAt(state, i)) continue;
    const body = bodyAt(state, i);
    const distance = Math.abs(body.x - from.x) + Math.abs(body.z - from.z);
    if (distance < bestDistance) {
      best = body;
      bestDistance = distance;
    }
  }
  return best;
}

/** Cíl pravidla `interact`, ke kterému jít: s `order` první nehotový, jinak nejbližší nehotový. */
function interactGoal(view: View, interact: CompiledInteract): Body | null {
  const { state } = view;
  const count = state[HEADER.bodyCount] as number;
  let best: Body | null = null;
  for (let i = 0; i < count; i += 1) {
    if (i === view.player || roleOf(state, i) !== interact.role || !aliveAt(state, i) || targetStateOf(state, i) >= interact.states - 1) continue;
    const body = bodyAt(state, i);
    if (interact.order === true) return body;
    if (best === null || Math.abs(body.x - view.me.x) + Math.abs(body.z - view.me.z) < Math.abs(best.x - view.me.x) + Math.abs(best.z - view.me.z)) best = body;
  }
  return best;
}

/** Role má tělo, které se teprve ukáže (skryté a ještě nepřepnuté)? */
function hiddenOf(state: Int32Array, role: number): boolean {
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (roleOf(state, i) === role && (flagsOf(state, i) & (FLAG.alive | FLAG.switched)) === 0) return true;
  }
  return false;
}

/** Zeď dvorku z plotů: z a nejširší nezakrytá mezera (brána). */
function wallOf(state: Int32Array): Wall | null {
  const count = state[HEADER.bodyCount] as number;
  const fences: Body[] = [];
  for (let i = 0; i < count; i += 1) {
    if (roleOf(state, i) === ROLE.obstacle && (flagsOf(state, i) & (FLAG.alive | FLAG.solid)) === (FLAG.alive | FLAG.solid)) fences.push(bodyAt(state, i));
  }
  if (fences.length === 0) return null;
  fences.sort((a, b) => a.x - b.x);
  let from = -YARD.half;
  let best = { x: 0, width: -1 };
  for (const fence of [...fences, { x: YARD.half, w: 0 } as Body]) {
    const left = fence.x - fence.w / 2;
    if (left - from > best.width) best = { x: Math.trunc((from + left) / 2), width: left - from };
    from = Math.max(from, fence.x + fence.w / 2);
  }
  return { z: fences[0]!.z, gapX: best.x, gapWidth: best.width };
}

// ---------------------------------------------------------------------------
// Pravidla

const has = (rule: CompiledRule, key: string): boolean => rule.do.some((effect) => key in effect);
const contactOf = (rule: CompiledRule): readonly [number, number] | null => ('contact' in rule.when ? rule.when.contact : null);

/** Pravidlo, které hráči dá do ruky tělo role `role`. */
const grabRuleFor = (view: View, role: number): CompiledRule | undefined =>
  view.rules.find((rule) => {
    if (!has(rule, 'grab')) return false;
    const contact = contactOf(rule);
    if (contact !== null && contact[0] === ROLE.player && contact[1] === role) return true;
    return rule.if.some((cond) => 'near' in cond && cond.near.role === role);
  });

const holdingRule = (view: View, role: number, effect: 'throwHeld' | 'release'): CompiledRule | undefined =>
  view.rules.find((rule) => has(rule, effect) && rule.if.every((cond) => !('holding' in cond) || cond.holding === role));

const pushRuleFor = (view: View, role: number): CompiledRule | undefined =>
  view.rules.find((rule) => {
    const contact = contactOf(rule);
    return has(rule, 'push') && contact !== null && contact[0] === ROLE.player && contact[1] === role;
  });

const toggleRulesFor = (view: View, role: number): CompiledRule[] => view.rules.filter((rule) => rule.do.some((effect) => 'toggle' in effect && effect.toggle === role));

const counterRulesFor = (view: View, name: ArcadeCounter): CompiledRule[] =>
  view.rules.filter((rule) => rule.do.some((effect) => ('count' in effect && effect.count.counter === name && effect.count.amount > 0) || (name === 'score' && 'score' in effect && effect.score > 0)));

const counterValue = (state: Int32Array, name: ArcadeCounter): number => state[HEADER.counters + COUNTER[name]] as number;

// ---------------------------------------------------------------------------
// Pohyb

const playerSize = (view: View): Body => bodyAt(view.state, view.player);

/**
 * Cesta k bodu: přes zeď jen branou. Stojí-li v bráně pevné tělo (dveře),
 * plán se odbočí k pravidlu, které ho přepne.
 */
function navigate(view: View, target: { readonly x: number; readonly z: number }, arrive: boolean, depth: number, seen: ReadonlySet<CompiledRule>): Action | null {
  const { wall, me } = view;
  if (wall === null) return { kind: 'move', x: target.x, z: target.z, arrive };
  const side = Math.sign(me.z - wall.z) || -1;
  const inWall = Math.abs(target.z - wall.z) <= YARD.wallDepth;
  const crossing = !inWall && Math.sign(target.z - wall.z) !== side;
  const slack = Math.max(0, wall.gapWidth / 2 - playerSize(view).w / 2 - 100);
  const offGap = Math.abs(me.x - wall.gapX) > slack;
  if (inWall) {
    // K bráně z boku ne: napřed před ni, pak rovně.
    if (offGap && Math.abs(me.z - wall.z) < 2 * YARD.wallDepth + 1500) return { kind: 'move', x: wall.gapX, z: wall.z + side * 2000, arrive: true };
    return { kind: 'move', x: target.x, z: target.z, arrive };
  }
  if (!crossing) return { kind: 'move', x: target.x, z: target.z, arrive };
  const blocker = gapBlocker(view, wall);
  if (blocker !== null) {
    for (const rule of toggleRulesFor(view, roleOf(view.state, blocker))) {
      const action = achieve(view, rule, depth + 1, seen);
      if (action !== null) return action;
    }
    return null;
  }
  if (offGap) return { kind: 'move', x: wall.gapX, z: wall.z + side * 1500, arrive: true };
  return { kind: 'walk', axis: 'z', dir: -side, buttons: 0 };
}

/** Živé pevné tělo v bráně (dveře), nebo −1 → null. */
function gapBlocker(view: View, wall: Wall): number | null {
  const { state } = view;
  const count = state[HEADER.bodyCount] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === view.player || roleOf(state, i) === ROLE.obstacle) continue;
    if ((flagsOf(state, i) & (FLAG.alive | FLAG.solid)) !== (FLAG.alive | FLAG.solid)) continue;
    const body = bodyAt(state, i);
    if (Math.abs(body.z - wall.z) <= YARD.wallDepth && Math.abs(body.x - wall.gapX) * 2 < wall.gapWidth + body.w) return i;
  }
  return null;
}

/** Kam tělo s rychlostí `v` dojede třením jádra. */
function slide(v: number): number {
  let distance = 0;
  for (let speed = Math.abs(v); speed > 0; speed -= 8) distance += speed;
  return Math.sign(v) * distance;
}

const coord = (point: { readonly x: number; readonly z: number }, axis: Axis): number => (axis === 'x' ? point.x : point.z);

/** Strká tělo `mover` k tělu `target`: po jedné ose, pak po druhé, vždy zezadu. */
function pushToward(view: View, mover: Body, target: Body): Action {
  const rest = { x: mover.x + slide(mover.vx), z: mover.z + slide(mover.vz) };
  const tolX = (mover.w + target.w) / 2 - ALIGN;
  const tolZ = (mover.d + target.d) / 2 - ALIGN;
  let axis: Axis;
  if (Math.abs(target.x - rest.x) > tolX) axis = 'x';
  else if (Math.abs(target.z - rest.z) > tolZ) axis = 'z';
  else return WAIT;
  const other: Axis = axis === 'x' ? 'z' : 'x';
  const dir = Math.sign(coord(target, axis) - coord(rest, axis));
  const player = playerSize(view);
  const halfAlong = (axis === 'x' ? player.w + mover.w : player.d + mover.d) / 2;
  const clear = (axis === 'x' ? player.d + mover.d : player.w + mover.w) / 2 + 500;
  const along = (coord(view.me, axis) - coord(mover, axis)) * dir;
  const lateral = coord(view.me, other) - coord(mover, other);
  const point = (u: number, v: number): { x: number; z: number } => (axis === 'x' ? { x: u, z: v } : { x: v, z: u });
  const stand = coord(mover, axis) - dir * (halfAlong + 300);
  if (along > -halfAlong) {
    // Hráč je vedle nebo před tělem: obejít bokem, jinak by ho strčil špatně.
    if (Math.abs(lateral) < clear) return { kind: 'move', ...point(coord(view.me, axis), coord(mover, other) + (Math.sign(lateral) || 1) * clear), arrive: true };
    return { kind: 'move', ...point(stand, coord(view.me, other)), arrive: true };
  }
  if (Math.abs(lateral) > ALIGN) return { kind: 'move', ...point(stand, coord(mover, other)), arrive: true };
  return { kind: 'walk', axis, dir, buttons: 0 };
}

/**
 * Hod po ose z: zarovnat se s cílem na rozběhu `THROW_RUNUP` za místem hodu,
 * pak rovně k cíli – jádro hází po poslední rychlosti hráče, takže rozběh je
 * mířidlo – a stisk ve vzdálenosti `THROW_RANGE`.
 */
function throwAt(view: View, target: Body, rule: CompiledRule): Action {
  const { me } = view;
  const side = Math.sign(me.z - target.z) || -1;
  const standZ = target.z + side * THROW_RANGE;
  if (Math.abs(me.x - target.x) > ALIGN || (me.z - standZ) * side < -800) return { kind: 'move', x: target.x, z: standZ + side * THROW_RUNUP, arrive: true };
  const buttons = 'press' in rule.when ? rule.when.press : BUTTON.TAP;
  return { kind: 'walk', axis: 'z', dir: -side, buttons: (me.z - standZ) * side <= ALIGN ? buttons : 0 };
}

// ---------------------------------------------------------------------------
// Zpětné řetězení

/** Co udělat teď, aby pravidlo `rule` vystřelilo; null = robot neví jak. */
function achieve(view: View, rule: CompiledRule, depth: number, seen: ReadonlySet<CompiledRule>): Action | null {
  if (depth > MAX_DEPTH || seen.has(rule)) return null;
  const path = new Set(seen).add(rule);
  const { state } = view;
  const held = heldOf(state);
  const heldRole = held >= 0 && aliveAt(state, held) ? roleOf(state, held) : -1;
  const sub = (next: CompiledRule | undefined): Action | null => (next === undefined ? null : achieve(view, next, depth + 1, path));
  const dropHeld = (): Action | null => sub(holdingRule(view, heldRole, 'release')) ?? sub(holdingRule(view, heldRole, 'throwHeld'));

  for (const cond of rule.if) {
    if ('holding' in cond) {
      if (heldRole === cond.holding) continue;
      return heldRole >= 0 ? dropHeld() : sub(grabRuleFor(view, cond.holding));
    }
    if ('notHolding' in cond) {
      if (heldRole < 0) continue;
      return dropHeld();
    }
    if ('counter' in cond) {
      const value = counterValue(state, cond.counter.name);
      if (cond.counter.below !== undefined && value >= cond.counter.below) return null;
      if (cond.counter.atLeast === undefined || value >= cond.counter.atLeast) continue;
      for (const next of counterRulesFor(view, cond.counter.name)) {
        const action = sub(next);
        if (action !== null) return action;
      }
      return null;
    }
    const near = nearestOf(view, cond.near.role);
    if (near === null) return null;
    if (Math.max(Math.abs(near.x - view.me.x) - (near.w + playerSize(view).w) / 2, Math.abs(near.z - view.me.z) - (near.d + playerSize(view).d) / 2) > cond.near.within) {
      return navigate(view, near, false, depth, path);
    }
  }

  const when = rule.when;
  if ('press' in when) return { kind: 'press', buttons: when.press };
  if ('every' in when) return WAIT;
  if ('interact' in when) {
    // Krok hotový: pustit Use, jinak se týž cíl dál neposune.
    if (isLocked(interactRecord(state))) return WAIT;
    if (interactTarget(state, view.player, when.interact) >= 0) return { kind: 'press', buttons: BUTTON.INTERACT };
    const goal = interactGoal(view, when.interact);
    return goal === null ? null : navigate(view, goal, true, depth, path);
  }
  if ('hit' in when) return null;
  if ('counter' in when) {
    if (counterValue(state, when.counter.name) >= when.counter.atLeast) return WAIT;
    for (const next of counterRulesFor(view, when.counter.name)) {
      const action = sub(next);
      if (action !== null) return action;
    }
    return null;
  }
  const [a, b] = when.contact;
  if (a === ROLE.player) return reach(view, b, depth, path);
  return bring(view, a, b, heldRole, depth, path) ?? bring(view, b, a, heldRole, depth, path);
}

/** Dojít k tělu role; skryté tělo napřed odhalí pravidlo, které ho přepne. */
function reach(view: View, role: number, depth: number, seen: ReadonlySet<CompiledRule>): Action | null {
  const body = nearestOf(view, role);
  if (body !== null) return navigate(view, body, false, depth, seen);
  if (!hiddenOf(view.state, role)) return null;
  for (const rule of toggleRulesFor(view, role)) {
    const action = achieve(view, rule, depth + 1, seen);
    if (action !== null) return action;
  }
  return null;
}

/** Dostat tělo role `mover` do dotyku s tělem role `target`: hodem, nesením, položením, nebo strkáním. */
function bring(view: View, mover: number, target: number, heldRole: number, depth: number, seen: ReadonlySet<CompiledRule>): Action | null {
  const moverBody = heldRole === mover ? null : nearestOf(view, mover);
  const goal = nearestOf(view, target, moverBody ?? view.me);
  if (goal === null) return hiddenOf(view.state, target) ? reach(view, target, depth, seen) : null;
  if (heldRole === mover) {
    const toss = holdingRule(view, mover, 'throwHeld');
    if (toss !== undefined && !seen.has(toss)) return throwAt(view, goal, toss);
    // Nesené tělo jede na hlavě: dotkne se jen cíle vyššího než hráč.
    if (goal.h > playerSize(view).h) return navigate(view, goal, false, depth, seen);
    const drop = holdingRule(view, mover, 'release');
    if (drop === undefined) return null;
    const close = Math.abs(goal.x - view.me.x) + Math.abs(goal.z - view.me.z) < (goal.w + playerSize(view).w) / 2 + 600;
    return close ? achieve(view, drop, depth + 1, seen) : navigate(view, goal, true, depth, seen);
  }
  if (moverBody === null) return null;
  const grab = grabRuleFor(view, mover);
  if (grab !== undefined && heldRole < 0) return achieve(view, grab, depth + 1, seen);
  if (pushRuleFor(view, mover) !== undefined) return pushToward(view, moverBody, goal);
  return null;
}

// ---------------------------------------------------------------------------
// Vstup

const AXIS_OF: Readonly<Record<Axis, readonly [number, number]>> = {
  // [osa pro +, osa pro −] v kódování `move_free` (0 = +z, 8 = +x, 16 = −z, 24 = −x).
  x: [AXIS_MAX / 2, -AXIS_MAX / 2],
  z: [1, AXIS_MAX],
};

/** Brzdná dráha hráče `move_free` z rychlosti `speed`. */
function stopping(speed: number): number {
  let distance = 0;
  for (let v = speed - ARENA.friction; v > 0; v -= ARENA.friction) distance += v;
  return distance;
}

function inputOf(view: View, action: Action): ArcadeInput {
  if (action.kind === 'wait') return NO_INPUT;
  if (action.kind === 'press') return { buttons: action.buttons, axis: 0 };
  if (action.kind === 'walk') return { buttons: action.buttons, axis: AXIS_OF[action.axis][action.dir > 0 ? 0 : 1] };
  const dx = action.x - view.me.x;
  const dz = action.z - view.me.z;
  const distance = Math.hypot(dx, dz);
  if (action.arrive && distance <= Math.max(100, stopping(Math.hypot(view.me.vx, view.me.vz)) + 30)) return NO_INPUT;
  return { buttons: 0, axis: arenaAxis(Math.round(dx), Math.round(dz)) };
}

export interface RulesPlanner {
  readonly reactionTicks: number;
  decide(observation: ArcadeObservation): ArcadeInput;
}

/**
 * Plánovač pro svět, kde výhru nesou pravidla specu a hráč chodí volně
 * (dvorek z `rules/compile.ts`); jinak null a hraje robot světa.
 */
export function rulesPlanner(world: ArcadeWorld): RulesPlanner | null {
  if (world.control.id !== 'move_free') return null;
  const rules = world.rules.filter((ref) => ref.id in SPEC_RULES).map((ref) => compiledRuleSchema.parse(ref.params));
  const wins = rules.filter((rule) => has(rule, 'win'));
  if (wins.length === 0) return null;
  return {
    reactionTicks: REACTION,
    decide: ({ state, player, recent }) => {
      const view: View = { state, player, me: predict(state, player, recent), rules, wall: wallOf(state) };
      for (const rule of wins) {
        const action = achieve(view, rule, 0, new Set());
        if (action !== null) return inputOf(view, action);
      }
      return NO_INPUT;
    },
  };
}
