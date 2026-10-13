/**
 * Robot akcí (P46A T6): krok, který obal robota `addon_bot` udělá po
 * základním robotovi a doplňcích. Vidí stav o `recent.length` tiků starý,
 * takže polohy předpovídá jejich rychlostí. Střílí jako robot `+shoot`,
 * udeří a sebere, co bude v dosahu, a dash nebo štít zapne před nárazem.
 *
 * Ochranné akce a úder se dokážou jen dotykem, kterému se základní robot
 * vyhýbá. Proto robot s připravenou akcí neuhne tělu, které na hrdinu míří:
 * nechá ho přijít a akci zmáčkne včas. Akce ho ochrání, takže tah nic nestojí.
 */

import { shootStep } from '../addons';
import { ABILITY_SLOTS, AXIS_MAX, type AbilityId, type ArcadeInput, type ArcadeObservation, BODY, BUTTON, FLAG, HEADER, type PieceRef, ROLE, UNIT, bodyBase } from '../contract';
import { arenaAxis } from '../pieces/arena';
import { ABILITY_BUTTONS, ABILITY_TIMING, type AbilityBot, abilityActive, abilityCooldown } from './state';
import { inStrikeReachWithin } from './strike';

/** Jak daleko dopředu (tiky po zmáčknutí) robot hlídá tělo, kvůli kterému neuhne. */
const COMMIT_TICKS = 24;
/** Na řízení dál: auto potřebuje čas zatočit ke stopě nepřítele. */
const STEER_COMMIT_TICKS = 75;

/** Čím se kdo vyhýbá – robot v nasazení tyhle vstupy zahodí. */
const EVADE: Readonly<Record<string, number>> = {
  runner_bot: BUTTON.LEFT | BUTTON.RIGHT | BUTTON.TAP | BUTTON.DOWN,
  platform_bot: BUTTON.TAP | BUTTON.UP,
  steer_bot: 0,
};

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/**
 * Rozestup těla od hrdiny v ose je v t lineární: nejmenší je na kraji okna `from..to`, nebo nula,
 * když mezi kraji mění znaménko. Tělo, které se ani tak nepřiblíží, se nedotkne v žádném tiku.
 */
function apart(state: Int32Array, p: number, b: number, axis: number, speed: number, size: number, from: number, to: number): boolean {
  const gap = (state[b + axis] as number) - (state[p + axis] as number);
  const drift = (state[b + speed] as number) - (state[p + speed] as number);
  const near = gap + drift * from;
  const far = gap + drift * to;
  const least = Math.sign(near) !== Math.sign(far) ? 0 : Math.min(Math.abs(near), Math.abs(far));
  return least * 2 >= (state[p + size] as number) + (state[b + size] as number);
}

/** První tik v `from..to` (od pozorování), kdy se hrdina a tělo dotknou, když oba letí dál svou rychlostí; jinak −1. */
export function contactAt(state: Int32Array, player: number, body: number, from: number, to: number): number {
  const p = bodyBase(player);
  const b = bodyBase(body);
  const py = state[p + BODY.y] as number;
  const by = state[b + BODY.y] as number;
  if (!(py < by + (state[b + BODY.h] as number) && by < py + (state[p + BODY.h] as number))) return -1;
  // R5: robot se ptá u každého těla trati v každém tiku – vzdálená těla vyřadí dřív než smyčka.
  if (apart(state, p, b, BODY.x, BODY.vx, BODY.w, from, to) || apart(state, p, b, BODY.z, BODY.vz, BODY.d, from, to)) return -1;
  const at = (base: number, axis: number, speed: number, t: number): number => (state[base + axis] as number) + (state[base + speed] as number) * t;
  for (let t = from; t <= to; t += 1) {
    const dx = Math.abs(at(b, BODY.x, BODY.vx, t) - at(p, BODY.x, BODY.vx, t));
    const dz = Math.abs(at(b, BODY.z, BODY.vz, t) - at(p, BODY.z, BODY.vz, t));
    if (dx * 2 < (state[p + BODY.w] as number) + (state[b + BODY.w] as number) && dz * 2 < (state[p + BODY.d] as number) + (state[b + BODY.d] as number)) return t;
  }
  return -1;
}

/** Živá těla kromě hrdiny podle role, v pořadí indexu – krok akcí je projde jednou za tik (R5). */
function livingByRole(state: Int32Array, player: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (i === player || !alive(state, i)) continue;
    const role = state[bodyBase(i) + BODY.role] as number;
    let bodies = out.get(role);
    if (bodies === undefined) out.set(role, (bodies = []));
    bodies.push(i);
  }
  return out;
}

/** Živá těla rolí `roles` kromě hrdiny. */
function bodiesOf(state: Int32Array, player: number, roles: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (i !== player && roles.includes(state[bodyBase(i) + BODY.role] as number) && alive(state, i)) out.push(i);
  }
  return out;
}

interface Slot {
  readonly id: AbilityId;
  readonly button: number;
  /** Tik (od pozorování), kdy akce naposled začala z vlastního stisku v `recent`, jinak −1. */
  readonly pressed: number;
  /** Je akce v tiku zmáčknutí (`recent.length`) připravená? */
  readonly ready: boolean;
  /** Tik (od pozorování), od kterého půjde akce zmáčknout. */
  readonly readyAt: number;
  /** Poslední tik (od pozorování), ve kterém je akce ještě aktivní. */
  readonly activeUntil: number;
}

function slotsOf(observation: ArcadeObservation, params: AbilityBot): Slot[] {
  const { state, recent } = observation;
  const n = recent.length;
  return params.ids.map((id, slot) => {
    const button = ABILITY_BUTTONS[slot] as number;
    let pressed = -1;
    recent.forEach((seen, j) => {
      if ((seen.buttons & button) !== 0) pressed = j;
    });
    const timing = ABILITY_TIMING[id];
    const cooldown = abilityCooldown(state, params.keeper, slot);
    const readyAt = pressed < 0 ? cooldown : pressed + timing.cooldown;
    const activeUntil = pressed >= 0 ? pressed + timing.active - 1 : abilityActive(state, params.keeper, slot) - 1;
    return { id, button, pressed, ready: readyAt <= n, readyAt, activeUntil };
  });
}

/** Jak daleko od stopy smí na řízení tělo ležet, aby k němu robot zatočil. */
const STEER_SEEK = 3 * UNIT;

/**
 * Řízení jede po závodní stopě a nepříteli by se minulo i bez úhybu: tělo
 * před autem blízko stopy dostane odhad dotyku podle vzdálenosti a robot k němu zatočí.
 */
function aheadAt(state: Int32Array, player: number, body: number, from: number, to: number): number {
  const p = bodyBase(player);
  const b = bodyBase(body);
  const vz = Math.max(1, state[p + BODY.vz] as number);
  const dz = (state[b + BODY.z] as number) - (state[p + BODY.z] as number) - Math.floor(((state[p + BODY.d] as number) + (state[b + BODY.d] as number)) / 2);
  // Soupeřovo auto (pohyblivý `enemy`) není cíl – honička za ním by prohrála závod.
  if (((state[b + BODY.flags] as number) & FLAG.kinematic) !== 0) return -1;
  if (dz < 0 || Math.abs((state[b + BODY.x] as number) - (state[p + BODY.x] as number)) > STEER_SEEK) return -1;
  const at = Math.ceil(dz / vz);
  return at >= from && at <= to ? at : -1;
}

/**
 * Tělo, kterému robot neuhne, a tik dotyku – nejbližší z těl `targets`, která akci patří (`owned`),
 * na kolizním kurzu (`contact` = tik dotyku, nebo −1). Vlastníka zjišťuje až u těl s dotykem.
 */
function oncoming(targets: readonly number[], contact: (body: number) => number, owned: (body: number) => boolean): { body: number; at: number } | null {
  let best: { body: number; at: number } | null = null;
  for (const body of targets) {
    const at = contact(body);
    if (at >= 0 && (best === null || at < best.at) && owned(body)) best = { body, at };
  }
  return best;
}

/** Roboti ovládání s pohledem shora (`AROUND_CONTROLS`): úder a krádež sahají kolem hrdiny. */
const AROUND_BOTS: readonly string[] = ['arena_bot', 'walker_bot'];

/** Aréna: s připravenou akcí proti pronásledovateli jde robot k nejbližšímu blíž než tohle. */
const ARENA_SEEK = 8 * UNIT;

/**
 * Robot arény před pronásledovateli utíká, takže by úder, dash ani štít nikdy nepoužil.
 * S připravenou akcí jde k nejbližšímu tělu rolí `roles` v dosahu `ARENA_SEEK`; jinak `undefined`.
 */
function seekAxis(state: Int32Array, player: number, roles: readonly number[]): number | undefined {
  const p = bodyBase(player);
  let best: { dx: number; dz: number; d: number } | undefined;
  for (const body of bodiesOf(state, player, roles)) {
    const dx = (state[bodyBase(body) + BODY.x] as number) - (state[p + BODY.x] as number);
    const dz = (state[bodyBase(body) + BODY.z] as number) - (state[p + BODY.z] as number);
    const d = Math.max(Math.abs(dx), Math.abs(dz));
    if (d < ARENA_SEEK && (best === undefined || d < best.d)) best = { dx, dz, d };
  }
  return best === undefined ? undefined : arenaAxis(best.dx, best.dz);
}

const STRUCK = [ROLE.enemy, ROLE.chaser];
const LOOT = [ROLE.collectible, ROLE.enemy];
const ENEMY = [ROLE.enemy];

/** Role těl, na která akce sahá: střelba na nepřátele, úder a krádež na své cíle, dash a štít na nárazy. */
const rolesOf = (id: AbilityId, harm: readonly number[]): readonly number[] =>
  id === 'shoot' ? [ROLE.enemy] : id === 'strike' ? STRUCK : id === 'grab' ? LOOT : harm;

/** Tělo, na které smí každý uchazeč. */
const SHARED = -1;

/**
 * Dvojice akcí (R4): z těl role, na kterou sahá víc uchazečů (nepřítel pro
 * střelbu i úder, náraz pro dash i štít), dostane každá akce jedno výhradně –
 * první tělo střelba (na řízení jde trefit jen nepřítele na úvodní rovince),
 * další ostatní akce v pořadí tlačítek. Jinak první akce sebere druhé každou
 * příležitost (střela zabije nepřítele dřív, než dojde na úder; štít s delším
 * oknem pohltí náraz dřív než dash) a sloveso druhé se nedokáže. Doplněk
 * `+shoot` (`fire`) sloveso dokazovat nemusí: tělo nedostane, jen ustoupí.
 * Ostatní těla zůstávají všem, ať robot přežije jako s jednou akcí. Pořadí je
 * podle indexu těla (i mrtvého), takže se mezi tiky nemění; pohyblivá těla
 * (soupeřova auta) se nepočítají. Vrací slot akce, nebo `SHARED`.
 */
function ownerOf(state: Int32Array, ids: readonly AbilityId[], harm: readonly number[], fire: boolean): (body: number) => number {
  const order = [...ids.keys()].sort((a, b) => Number(ids[b] === 'shoot') - Number(ids[a] === 'shoot'));
  if (order.length + (fire ? 1 : 0) < 2) return () => SHARED;
  const owners = new Map<number, number>();
  const ranks = new Map<number, number>();
  const byRole = new Map<number, number[]>();
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (((state[b + BODY.flags] as number) & FLAG.kinematic) !== 0) continue;
    const role = state[b + BODY.role] as number;
    let mine = byRole.get(role);
    if (mine === undefined) byRole.set(role, (mine = order.filter((slot) => rolesOf(ids[slot] as AbilityId, harm).includes(role))));
    const rank = ranks.get(role) ?? 0;
    const rivals = mine.length + (fire && role === ROLE.enemy && !ids.includes('shoot') ? 1 : 0);
    if (rivals < 2 || rank >= mine.length) continue;
    ranks.set(role, rank + 1);
    owners.set(i, mine[rank] as number);
  }
  return (body) => owners.get(body) ?? SHARED;
}

/**
 * Krok akcí. `base` = základní robot pod obaly (podle něj se pozná, čím se uhýbá).
 * Vrací vstup s tlačítky akcí a bez úhybu, když robot nechává tělo přijít.
 * `fire` = svět má i doplněk `+shoot`: jeho FIRE je další uchazeč o nepřátele.
 */
export function abilityStep(observation: ArcadeObservation, input: ArcadeInput, base: PieceRef, params: AbilityBot, fire = false): ArcadeInput {
  const { state, player, recent } = observation;
  const n = recent.length;
  const steer = base.id === 'steer_bot';
  // Překážky řízení jsou svodidla a kraj silnice: robot k nim nezatáčí, náraz mimo okno dashe stojí život (R4, a14).
  const harm = params.harm.map((role) => ROLE[role]).filter((role) => !steer || role !== ROLE.obstacle);
  const around = AROUND_BOTS.includes(base.id);
  const slots = slotsOf(observation, params);
  let living: Map<number, number[]> | undefined;
  const lists = new Map<readonly number[], readonly number[]>();
  const of = (roles: readonly number[]): readonly number[] => {
    let bodies = lists.get(roles);
    if (bodies !== undefined) return bodies;
    const byRole = (living ??= livingByRole(state, player));
    bodies = roles.length === 1 ? byRole.get(roles[0] as number) ?? [] : [...new Set(roles)].flatMap((role) => byRole.get(role) ?? []).sort((a, b) => a - b);
    lists.set(roles, bodies);
    return bodies;
  };
  // Přidělení prochází všechna těla: spočítá se až u prvního těla, na kterém záleží (většinu tiků žádné).
  let assignment: ((body: number) => number) | undefined;
  const assigned = (body: number): number => (assignment ??= ownerOf(state, params.ids, harm, fire))(body);
  const horizon = steer ? STEER_COMMIT_TICKS : COMMIT_TICKS;
  // Tik dotyku a vlastník se v jednom tiku robota nemění: každé tělo se spočítá jednou (R5).
  const contacts = new Map<number, number>();
  const contact = (body: number): number => {
    let at = contacts.get(body);
    if (at === undefined) contacts.set(body, (at = steer ? aheadAt(state, player, body, n, n + horizon) : contactAt(state, player, body, n, n + horizon)));
    return at;
  };
  // Přidělení propadne, když vlastník do dotyku nebude připravený ani aktivní: tělo by prošlo bez obrany.
  // Jen tehdy – úder, který jednou mine, to za cooldown zkusí znovu a tělo mu mezitím nesmí vzít druhá akce.
  const owners = new Map<number, number>();
  const owner = (body: number): number => {
    const known = owners.get(body);
    if (known !== undefined) return known;
    const slot = slots[assigned(body)];
    const at = slot === undefined || slot.ready ? -1 : contact(body);
    const own = slot === undefined || at < 0 || slot.activeUntil >= at || slot.readyAt < at ? assigned(body) : SHARED;
    owners.set(body, own);
    return own;
  };
  const mine = (slot: number) => (body: number) => owner(body) === slot || owner(body) === SHARED;
  // Doplněk střílí na nepřátele akce střelby, když ji hra má; jinak (−1 = `SHARED`) jen na společné.
  const blaster = params.ids.indexOf('shoot');
  let buttons = input.buttons;
  if (fire && (buttons & BUTTON.FIRE) !== 0) {
    const fired = shootStep(observation, { buttons: 0, axis: input.axis }, base, mine(blaster)).buttons & BUTTON.FIRE;
    buttons = (buttons & ~BUTTON.FIRE) | fired;
  }
  /** Tělo, kterému robot neuhne (−1 = uhýbá jako obvykle). */
  let hold = -1;
  /** Aréna: role, ke kterým robot s připravenou akcí půjde. */
  const seek: number[] = [];
  for (const [index, slot] of slots.entries()) {
    const owned = mine(index);
    // I v aktivním okně: robot, který po stisku zase uteče, by se štítem (40 tiků) nikdy nedotkl.
    if (base.id === 'arena_bot' && (slot.ready || slot.activeUntil >= n) && slot.id !== 'shoot' && slot.id !== 'grab') seek.push(...(slot.id === 'strike' ? STRUCK : harm));
    if (slot.id === 'shoot') {
      // Robot `+shoot` mačká FIRE; tady stejné rozhodnutí na tlačítko akce.
      const seen = { ...observation, recent: recent.map((r) => ((r.buttons & slot.button) !== 0 ? { ...r, buttons: r.buttons | BUTTON.FIRE } : r)) };
      if ((shootStep(seen, { buttons: 0, axis: input.axis }, base, owned).buttons & BUTTON.FIRE) !== 0) buttons |= slot.button;
      continue;
    }
    if (slot.id === 'strike' || slot.id === 'grab') {
      if (slot.ready) {
        const last = n + ABILITY_TIMING[slot.id].active - 1;
        const hits = (body: number): boolean => inStrikeReachWithin(state, player, body, n, last, around);
        // Úder a krádež berou všechno v dosahu: nezmáčknout, když by vzaly i tělo přidělené druhé akci.
        const struck = of(slot.id === 'strike' ? STRUCK : LOOT).filter(hits);
        if (struck.length > 0 && struck.every(owned)) buttons |= slot.button;
      }
      // Úder a krádež nepřítele chtějí, aby přišel: s připravenou akcí neuhnout tomu, co míří na hrdinu.
      const threat = oncoming(of(slot.id === 'strike' ? STRUCK : ENEMY), contact, owned);
      if (threat !== null && (slot.ready || slot.activeUntil >= threat.at)) hold = threat.body;
      continue;
    }
    const threat = oncoming(of(harm), contact, owned);
    // Dash i štít (blok) chrání jen po okno: zmáčknout, až dotyk padne do jeho první půlky.
    // Náboj štítu spotřebovaný v posledních tikách robot ještě nevidí – riziko jednoho zásahu.
    const active = ABILITY_TIMING[slot.id].active;
    if (threat !== null && slot.ready && threat.at >= n + 1 && threat.at <= n + Math.floor(active / 2)) buttons |= slot.button;
    if (threat !== null && (slot.ready || slot.activeUntil >= threat.at)) hold = threat.body;
  }
  const toward = seek.length === 0 ? undefined : seekAxis(state, player, seek);
  if (toward !== undefined) return { buttons, axis: toward };
  if (hold < 0) return { buttons, axis: input.axis };
  const evade = EVADE[base.id] ?? 0;
  if (!steer) return { buttons: buttons & ~evade, axis: input.axis };
  const dx = (state[bodyBase(hold) + BODY.x] as number) - (state[bodyBase(player) + BODY.x] as number);
  return { buttons: buttons & ~BUTTON.DOWN, axis: Math.max(-AXIS_MAX, Math.min(AXIS_MAX, Math.trunc((dx * AXIS_MAX) / UNIT))) };
}
