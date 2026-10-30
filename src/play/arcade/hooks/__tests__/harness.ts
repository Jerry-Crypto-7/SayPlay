/**
 * Společné kusy testů háčků (P66 T3): ruční spec souboje s koly a vylepšením, malý svět s testovacími pravidly
 * (výhra, sebrání, vznik věci a kombo v daných ticích) a přehrání, které si pamatuje zprávy háčků po ticích.
 */

import { z } from 'zod';

import { type GameSpecV1, readGameSpec } from '../../../spec';
import { arcadeWorldOf } from '../../compile';
import {
  type ArcadeEffect,
  type ArcadeState,
  type ArcadeWorld,
  type BodyInit,
  type BotPiece,
  type ControlPiece,
  HEADER,
  type InputEvent,
  NO_INPUT,
  type PieceRef,
  RUN_STATE,
  type RulePiece,
} from '../../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { type HookEffect, isHookEffect } from '../contract';
import { type HookParams, type HookRequest, withHooks } from '../index';
import fight from './hooks-fight-spec.json';

/** Ruční spec `genre.v6`: souboj arény, 3 vlny = 3 kola, výběr z `speed`, `fire_rate`, `extra_life` (bez klasifikátoru). */
export function fightSpec(patch: (spec: GameSpecV1) => GameSpecV1 = (spec) => spec): GameSpecV1 {
  const read = readGameSpec(patch(fight as unknown as GameSpecV1));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

/** Tentýž spec s `tuning` upraveným `edit`. */
export const fightTuned = (edit: (tuning: Record<string, unknown>) => Record<string, unknown>, version = 'genre.v6'): GameSpecV1 =>
  fightSpec((spec) => {
    const params = spec.controlParams as { generator: string; tuning: Record<string, unknown> };
    return { ...spec, genre: { ...spec.genre!, compilerVersion: version }, controlParams: { ...params, tuning: edit({ ...params.tuning }) } } as GameSpecV1;
  });

export function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

export interface Played {
  readonly state: ArcadeState;
  /** Zprávy háčků s tikem, ve kterém přišly. */
  readonly events: readonly (HookEffect & { readonly tick: number })[];
  /** Všechny efekty po ticích. */
  readonly effects: readonly (readonly ArcadeEffect[])[];
  /** Stav na konci každého tiku (jen s `snapshots`). */
  readonly states: readonly ArcadeState[];
}

/** Přehraje záznam jako `replay` v jádře a zapamatuje si zprávy háčků. */
export function play(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary = ARCADE_LIBRARY, options: { readonly horizon?: number; readonly snapshots?: boolean } = {}): Played {
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const events: (HookEffect & { tick: number })[] = [];
  const effects: (readonly ArcadeEffect[])[] = [];
  const states: ArcadeState[] = [];
  let next = 0;
  for (let tick = 0; tick < (options.horizon ?? 5400) && state[HEADER.runState] === RUN_STATE.running; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    const out = step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    effects.push(out);
    for (const effect of out) if (isHookEffect(effect)) events.push({ ...effect, tick });
    if (options.snapshots === true) states.push(state.slice());
  }
  return { state, events, effects, states };
}

export const ofKind = <K extends HookEffect['kind']>(played: Played, kind: K): (Extract<HookEffect, { kind: K }> & { readonly tick: number })[] =>
  played.events.filter((event): event is Extract<HookEffect, { kind: K }> & { tick: number } => event.kind === kind);

// ---------------------------------------------------------------------------
// Malý svět s testovacími pravidly

const atTicks = z.object({ at: z.array(z.int().min(0)) }).strict();
const atBodies = z.object({ at: z.array(z.tuple([z.int().min(0), z.int().min(0)])) }).strict();
const atCombos = z.object({ keeper: z.int().min(1), at: z.array(z.tuple([z.int().min(0), z.int().min(1)])) }).strict();
const atHooks = z.object({ tick: z.int().min(0) }).strict();
const tickOf = (state: ArcadeState): number => state[HEADER.tick] as number;

const rule = <P>(id: string, params: z.ZodType<P>, fire: (state: ArcadeState, params: P) => readonly ArcadeEffect[]): RulePiece<P> => ({
  id,
  params,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, p) => fire(state, p),
});

/** Všech osm druhů zpráv háčků – pro test, že jimi jádro jen projde. */
export const EVERY_HOOK_EFFECT: readonly HookEffect[] = [
  { kind: 'score_pop', amount: 30, body: 1 },
  { kind: 'callout', callout: 'combo_3' },
  { kind: 'round_start', round: 1, rounds: 3 },
  { kind: 'round_clear', round: 0, rounds: 3 },
  { kind: 'upgrade_offer', offer: ['speed', 'magnet', 'extra_life'] },
  { kind: 'upgrade_pick', card: 2, upgrade: 'extra_life' },
  { kind: 'rare_found', rarity: 'epic', body: 1 },
  { kind: 'boss_enter', body: 1 },
];

/**
 * Knihovna testů: hrdina stojí (`still`), robot nic nemačká (`idle_bot`); `win_at` vyhraje v daných ticích,
 * `collect_at` v tiku `[tik, tělo]` vydá dvojici sebrání (`score` 10 + `despawn`), `spawn_at` v tiku `[tik, předloha]`
 * kopii předlohy, `combo_at` v tiku `[tik, násobič]` zápis komba, `hook_messages` v tiku `tick` všech osm zpráv háčků.
 */
export const TEST_LIBRARY: ArcadeLibrary = {
  ...ARCADE_LIBRARY,
  controls: { ...ARCADE_LIBRARY.controls, still: { id: 'still', params: z.object({}).strict(), roles: ['player'], cost: () => ({ bodies: 1, rules: 0 }), step: () => undefined } as ControlPiece },
  bots: { ...ARCADE_LIBRARY.bots, idle_bot: { id: 'idle_bot', params: z.object({}).strict(), roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } as BotPiece },
  rules: {
    ...ARCADE_LIBRARY.rules,
    win_at: rule('win_at', atTicks, (state, p) => (p.at.includes(tickOf(state)) ? [{ kind: 'win' }] : [])) as RulePiece,
    collect_at: rule('collect_at', atBodies, (state, p) => p.at.filter(([tick]) => tick === tickOf(state)).flatMap(([, body]): ArcadeEffect[] => [{ kind: 'score', amount: 10 }, { kind: 'despawn', body }])) as RulePiece,
    spawn_at: rule('spawn_at', atBodies, (state, p) => p.at.filter(([tick]) => tick === tickOf(state)).map(([, template]): ArcadeEffect => ({ kind: 'spawn', template, x: 5000, y: 0, z: 5000, vx: 0, vy: 0, vz: 0 }))) as RulePiece,
    combo_at: rule('combo_at', atCombos, (state, p) => p.at.filter(([tick]) => tick === tickOf(state)).map(([, multiplier]): ArcadeEffect => ({ kind: 'combo', body: p.keeper, multiplier }))) as RulePiece,
    hook_messages: rule('hook_messages', atHooks, (state, p) => (tickOf(state) === p.tick ? EVERY_HOOK_EFFECT : [])) as RulePiece,
  },
};

const hero: BodyInit = { role: 'player', kind: 'hero', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false };
/** Sbíraná věc `k` (od 1) na místě, kam hrdina nedosáhne – sebrat ji jde jen pravidlem `collect_at`. */
export const item = (k: number, template = false): BodyInit => ({ role: 'collectible', kind: 'acorn', x: 3000 * k, y: 0, z: 9000, w: 500, h: 500, d: 500, solid: false, ...(template ? { template: true } : {}) });

/** Malý svět: hrdina, `items` věcí, test pravidla `rules` a háčky `request` (bez nich svět bez háčků), k nim `extra` parametry. */
export function testWorld(seed: number, items: readonly BodyInit[], rules: readonly PieceRef[], request?: HookRequest, extra: Partial<HookParams> = {}): ArcadeWorld {
  const parts = { level: { bodies: [hero, ...items], length: 0, spawnSlots: 4 }, rules, bot: { id: 'idle_bot', params: {} } };
  const hooked = request === undefined ? { ...parts, rules: [...rules] } : withHooks(parts, seed, request);
  const withExtra = hooked.rules.map((ref) => (ref.id === 'hooks' ? { id: 'hooks', params: { ...ref.params, ...extra } } : ref));
  const built = buildWorld({ seed, control: { id: 'still', params: {} }, rules: withExtra, bot: hooked.bot, level: hooked.level }, TEST_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}
