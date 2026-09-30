/**
 * Pravidlo `interact` (P32G T1): hráč v dosahu cíle drží „Use“
 * (`BUTTON.INTERACT`) aspoň `hold` tiků a stav cíle se posune o 1 (efekt
 * `stateChange`, stav 0..2 v `flags` těla). Ve specu je to spouštěč
 * `when: {interact: …}`, `do` platí pro cíl, který právě došel do konečného
 * stavu, a když jsou v konečném stavu všechny cíle role, pravidlo vyhraje.
 * `win` v `do` se u jednoho cíle zahodí – vyhrává se jen se všemi cíli.
 * Prohru (čas, chycení) skládají jiná pravidla.
 *
 * - Jedno držení = jeden krok: po posunu se týž cíl posune znovu až po puštění,
 *   takže `hold: 0` (stav ťukem) nepřeskočí stav a hasič, který drží dál, vidí
 *   kouř, než stříkne znovu.
 * - Puštění, odchod z dosahu nebo jiný cíl rozdělanou práci zahodí.
 * - `order`: posunout jde jen první cíl role (podle indexu těla), který ještě
 *   není v konečném stavu.
 * - `ready` (jen po překladu, staví ho generátor stanoviště): cíl, který se
 *   právě posunul, se dál posune jen v okně připravenosti – `after` tiků se peče,
 *   pak je `window` tiků zlatý, a když okno minul, peče se znovu (`readyPhase`).
 *   Obrácení mimo okno stav neposune; držení nachystané předem obrátí, jakmile
 *   se okno otevře.
 *
 * **Paměť držení:** pravidlo stav měnit nesmí, jen vydává efekty, a jádro nemá
 * slot pro rozdělanou práci. Drží ji proto čítač `trigger` (efekt `count`):
 * zapisuje ho jen obal `addon_control` (doplňky `+shoot` a `+chaser`) a HUD ho
 * neukazuje. Důsledky: svět smí mít jen jedno pravidlo `interact` a nesmí mít
 * obal doplňků – obal čítač každý tik přepíše, `hold > 0` se nikdy nedodrží
 * a robot hru nevyhraje, takže ji brána odmítne. Požadavek na vlastní slot
 * v jádře je v plánu P32G pod „Findings routed by the run“.
 *
 * Soubor nezávisí na `schema.ts` ani `compile.ts` – oba si odsud berou schémata,
 * takže by import zpět udělal cyklus.
 */

import { z } from 'zod';

import { ARCADE_HZ, type ArcadeEffect, BODY, BUTTON, COUNTER, FLAG, HEADER, type RuleContext, bodyBase, targetStateOf } from '../contract';

const states = z.union([z.literal(2), z.literal(3)]);

/** Spouštěč ve specu: `role` = cíle, `radius` v celých metrech, `hold` v ticích, `order` = cíle v pořadí. */
export const interactWhen = (role: z.ZodString) =>
  z
    .object({
      interact: z.object({ role, radius: z.int().min(1).max(20), hold: z.int().min(0).max(5 * ARCADE_HZ), states, order: z.boolean().optional() }).strict(),
    })
    .strict();

/** Okno připravenosti v ticích: `after` od posunu zavřené, pak `window` otevřené, dokola. */
const ready = z.object({ after: z.int().min(1).max(10 * ARCADE_HZ), window: z.int().min(1).max(10 * ARCADE_HZ) }).strict();

/** Po překladu: `role` = kód jádra, `radius` v jednotkách. */
export const compiledInteractWhen = z
  .object({
    interact: z
      .object({ role: z.int().min(0).max(255), radius: z.int().min(0), hold: z.int().min(0).max(5 * ARCADE_HZ), states, order: z.boolean().optional(), ready: ready.optional() })
      .strict(),
  })
  .strict();
export type CompiledInteract = z.infer<typeof compiledInteractWhen>['interact'];

// ---------------------------------------------------------------------------
// Rozdělaná práce v čítači `trigger`, 0 = nic:
// (cíl + 1) | tiky držení << 9 | (tik posunu mod ENTRY_SPAN + 1) << 18 (jen s `ready`)

const RECORD = HEADER.counters + COUNTER.trigger;
const BODY_BITS = 9;
const BODY_MASK = (1 << BODY_BITS) - 1;
const ENTRY_SHIFT = 2 * BODY_BITS;
/** Tik posunu se drží modulo tohle (13 bitů, 136 s) – okno se počítá z rozdílu, ne z absolutního tiku. */
const ENTRY_SPAN = (1 << 13) - 1;
/** Tiky držení po posunu: týž cíl se znovu posune až po puštění. Nad `hold` (nejvýš 5 s). */
const LOCKED = BODY_MASK;

export interface InteractRecord {
  /** Cíl rozdělané práce, −1 = žádný. */
  readonly body: number;
  /** Tiky držení v řadě; `LOCKED` = krok hotový, čeká se na puštění. */
  readonly held: number;
  /** Tik posledního posunu `body` (mod `ENTRY_SPAN`) + 1; 0 = neznámý. */
  readonly entry: number;
}

export const interactRecord = (state: Int32Array): InteractRecord => {
  const value = state[RECORD] as number;
  return { body: (value & BODY_MASK) - 1, held: (value >> BODY_BITS) & BODY_MASK, entry: value >>> ENTRY_SHIFT };
};

export const isLocked = (record: InteractRecord): boolean => record.held === LOCKED;

const pack = (body: number, held: number, entry = 0): number => (body + 1) | (held << BODY_BITS) | (entry << ENTRY_SHIFT);

/**
 * Kolik tiků zbývá do otevření okna (0 = otevřené), když `record` patří cíli
 * a zná tik posunu. Bez `ready` nebo bez tiku posunu je okno otevřené – cíl se
 * nesmí zaseknout.
 */
export function readyWait(interact: CompiledInteract, record: InteractRecord, body: number, tick: number): number {
  if (interact.ready === undefined || record.body !== body || record.entry === 0) return 0;
  const cycle = interact.ready.after + interact.ready.window;
  const phase = (((tick - (record.entry - 1)) % ENTRY_SPAN) + ENTRY_SPAN) % ENTRY_SPAN % cycle;
  return phase >= interact.ready.after ? 0 : interact.ready.after - phase;
}

/** Efekt, který čítač nastaví na `next` (jádro umí jen přičíst). */
function remember(state: Int32Array, next: number): ArcadeEffect[] {
  const amount = next - (state[RECORD] as number);
  return amount === 0 ? [] : [{ kind: 'count', counter: 'trigger', amount }];
}

// ---------------------------------------------------------------------------
// Cíle

const isAlive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

/** Mezera mezi obrysy v rovině x/z (0 = dotýkají se) – tatáž míra jako podmínka `near`. */
function gap(state: Int32Array, a: number, b: number): number {
  const pa = bodyBase(a);
  const pb = bodyBase(b);
  const dx = Math.max(0, Math.abs((state[pa + BODY.x] as number) - (state[pb + BODY.x] as number)) - Math.ceil(((state[pa + BODY.w] as number) + (state[pb + BODY.w] as number)) / 2));
  const dz = Math.max(0, Math.abs((state[pa + BODY.z] as number) - (state[pb + BODY.z] as number)) - Math.ceil(((state[pa + BODY.d] as number) + (state[pb + BODY.d] as number)) / 2));
  return Math.max(dx, dz);
}

/** Živé tělo role `role`, které ještě není v konečném stavu. */
const open = (state: Int32Array, body: number, interact: CompiledInteract): boolean =>
  state[bodyBase(body) + BODY.role] === interact.role && isAlive(state, body) && targetStateOf(state, body) < interact.states - 1;

/** Cíl, na kterém hráč pracuje: s `order` první otevřený, jinak nejbližší otevřený (shoda: nižší index); −1 = žádný v dosahu. */
export function interactTarget(state: Int32Array, player: number, interact: CompiledInteract): number {
  const count = state[HEADER.bodyCount] as number;
  let best = -1;
  let bestGap = interact.radius + 1;
  for (let body = 0; body < count; body += 1) {
    if (body === player || !open(state, body, interact)) continue;
    const d = gap(state, player, body);
    if (interact.order === true) return d <= interact.radius ? body : -1;
    if (d < bestGap) {
      best = body;
      bestGap = d;
    }
  }
  return best;
}

/** Jsou všechny živé cíle role v konečném stavu, když `body` právě do něj došel? */
function allDone(state: Int32Array, body: number, interact: CompiledInteract): boolean {
  const count = state[HEADER.bodyCount] as number;
  for (let other = 0; other < count; other += 1) if (other !== body && open(state, other, interact)) return false;
  return true;
}

/**
 * Jeden tik pravidla (spouštěč `press`, vstup je v `ctx.input`). `reached` vrátí
 * efekty `do` pravidla pro cíl, který právě došel do konečného stavu.
 */
export function interactFire(ctx: RuleContext, interact: CompiledInteract, reached: (body: number) => readonly ArcadeEffect[]): readonly ArcadeEffect[] {
  const { state, player } = ctx;
  const record = interactRecord(state);
  const target = (ctx.input.buttons & BUTTON.INTERACT) === 0 ? -1 : interactTarget(state, player, interact);
  // Puštění nebo odchod: držení se zahodí, tik posunu zůstane – okno připravenosti běží dál.
  if (target < 0) return remember(state, record.entry === 0 ? 0 : pack(record.body, 0, record.entry));
  if (record.body === target && record.held === LOCKED) return [];
  const mine = record.body === target;
  // Držení se zastaví na `hold`: nachystané předem čeká na okno.
  const held = Math.min(interact.hold, mine ? record.held + 1 : 1);
  const tick = state[HEADER.tick] as number;
  if (held < interact.hold || readyWait(interact, record, target, tick) > 0) return remember(state, pack(target, held, mine ? record.entry : 0));

  const next = targetStateOf(state, target) + 1;
  const final = next >= interact.states - 1;
  const entry = interact.ready === undefined || final ? 0 : (tick % ENTRY_SPAN) + 1;
  const effects: ArcadeEffect[] = [...remember(state, pack(target, LOCKED, entry)), { kind: 'stateChange', body: target, state: next }];
  if (!final) return effects;
  // `win` v `do` znamená „tohle je vítězné pravidlo“ – vyhrává se až se všemi cíli role, ne s prvním.
  const done = allDone(state, target, interact);
  effects.push(...reached(target).filter((effect) => effect.kind !== 'win'));
  if (done) effects.push({ kind: 'win' });
  return effects;
}
