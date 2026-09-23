/**
 * Arkádová cesta kompilátoru (P25A, T5; P25C, T5): `GameSpec` s `control`
 * `runner` / `platform` / `flap` / `shooter` / `throw` + seed → `ArcadeWorld` a `CompiledGame`.
 *
 * Ze specu se čte ovládání a jeho parametry a dvě koření z registru mechanik:
 * `health` (náraz ubere život místo prohry) a `timer` s `onEnd: 'lose'`
 * (časový limit). Ostatní mechaniky a role popisují příběh pro obálku, trať
 * je z generátoru. Hru, kterou robot nevyhraje, kompilátor vrátí jako
 * `UNWINNABLE` – dveře publikace pak zkusí další semínko.
 */

import { canonicalHash } from '@/ir/worlddoc';
import { type CompileGameResult, GAME_COMPILER_VERSION } from '@/play/contracts';
import { type GameSpecV1, arenaWinOf } from '@/play/spec';

import { ARCADE_LIMITS, ARCADE_RUNTIME_VERSION, type ArcadeLevel, type ArcadeWorld, type PieceRef } from './contract';
import { buildWorld, replay } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { arenaBotRef, arenaControlRef, arenaLevel, arenaRules } from './pieces/arena';
import { flapRules, flapTrack } from './pieces/flap';
import { platformLevel, platformRules } from './pieces/platform';
import { runnerTrack } from './pieces/runner';
import { duelParts } from './pieces/duel';
import { rhythmParts } from './pieces/rhythm';
import { shooterBotRef, shooterRange, shooterRules } from './pieces/shooter';
import { steerBotRef, steerControlRef, steerRules, steerTrack } from './pieces/steer';
import { throwField, throwRules } from './pieces/throw';
import { timingParts } from './pieces/timing';
import { runBot } from './verify';

/** Verze kompilátoru arkádové hry: mřížkový kompilátor + verze jádra. */
export const ARCADE_COMPILER_VERSION = `${GAME_COMPILER_VERSION}/${ARCADE_RUNTIME_VERSION}`;

export type ArcadeWorldResult = { readonly ok: true; readonly world: ArcadeWorld } | { readonly ok: false; readonly issues: readonly string[] };

/** Ovládání, trať a pravidla, která se liší podle `control`. */
interface ArcadeParts {
  readonly control: PieceRef;
  readonly bot: PieceRef;
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  /** Úroveň neprošla kontrolou hratelnosti z konstrukce – svět se nestaví. */
  readonly issues?: readonly string[];
  /** Životy, které ovládání samo určí (rytmus je zastropuje, souboj bez nich nejde). */
  readonly health?: number;
}

function partsOf(spec: GameSpecV1, seed: number, health: number | undefined): ArcadeParts {
  if (spec.control === 'timing') return timingParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'rhythm') return rhythmParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'duel') return duelParts(seed, { ...spec.controlParams }, health);
  if (spec.control === 'platform') {
    const params = platformLevel.params.parse({ ...spec.controlParams });
    return {
      control: { id: 'platform', params: { doubleJump: params.doubleJump } },
      bot: { id: 'platform_bot', params: {} },
      level: platformLevel.generate(seed, params),
      rules: platformRules(params, health),
    };
  }
  if (spec.control === 'steer') {
    const params = steerTrack.params.parse({ ...spec.controlParams });
    const level = steerTrack.generate(seed, params);
    return { control: steerControlRef(level, params), bot: steerBotRef(level, params), level, rules: steerRules(level) };
  }
  if (spec.control === 'move_free') {
    // `readGameSpec` už odmítl spec, kde by cíl a časovač nesouhlasily.
    const win = arenaWinOf(spec);
    const params = arenaLevel.params.parse({ ...spec.controlParams, ...('goal' in win ? win : {}) });
    const level = arenaLevel.generate(seed, params);
    return { control: arenaControlRef(), bot: arenaBotRef(), level, rules: arenaRules(level, params, health) };
  }
  if (spec.control === 'flap') {
    const params = flapTrack.params.parse({ ...spec.controlParams });
    return { control: { id: 'flap', params: {} }, bot: { id: 'flap_bot', params: {} }, level: flapTrack.generate(seed, params), rules: flapRules(health) };
  }
  if (spec.control === 'shooter') {
    const params = shooterRange.params.parse({ ...spec.controlParams });
    return { control: { id: 'shooter', params: {} }, bot: shooterBotRef(params), level: shooterRange.generate(seed, params), rules: shooterRules(params, health) };
  }
  if (spec.control === 'throw') {
    // Hod nemá čím ubrat život: `health` se nečte, prohra je „hody došly“.
    const params = throwField.params.parse({ ...spec.controlParams });
    return { control: { id: 'throw', params: {} }, bot: { id: 'throw_bot', params: {} }, level: throwField.generate(seed, params), rules: throwRules() };
  }
  const params = runnerTrack.params.parse({ ...spec.controlParams });
  const rules: PieceRef[] = [
    { id: 'hit', params: { role: 'obstacle', effect: health === undefined ? 'lose' : 'damage' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return { control: { id: 'runner', params: { speed: params.speed } }, bot: { id: 'runner_bot', params: {} }, level: runnerTrack.generate(seed, params), rules };
}

/** Spec + seed → svět. Bez ověření robotem – to dělá `compileArcade`. */
export function arcadeWorldOf(spec: GameSpecV1, seed: number): ArcadeWorldResult {
  const health = (spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max: number } | undefined)?.max;
  const timer = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds: number; readonly onEnd: string } | undefined;
  const parts = partsOf(spec, seed, health);
  const { control, bot, level, rules, issues } = parts;
  if (issues !== undefined && issues.length > 0) return { ok: false, issues };
  const lives = 'health' in parts ? parts.health : health;
  if (timer?.onEnd === 'lose') rules.push({ id: 'time_limit', params: { seconds: Math.min(ARCADE_LIMITS.maxTicks / 60, Math.max(10, timer.seconds)) } });

  const built = buildWorld({ seed, control, rules, bot, level, ...(lives === undefined ? {} : { health: lives }) }, ARCADE_LIBRARY);
  return built.ok ? { ok: true, world: built.world } : built;
}

export function compileArcade(spec: GameSpecV1, seed: number): CompileGameResult {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) return { ok: false, reason: 'WORLD_REJECTED', issues: made.issues };
  const { world } = made;
  const bot = runBot(world);
  if (bot.outcome !== 'won') return { ok: false, reason: 'UNWINNABLE', issues: [`the bot ${bot.outcome === 'lost' ? 'lost' : 'did not finish'} at tick ${bot.tick}, ${bot.distanceM} m into the track`] };
  // Trať, kterou vyhraje i nečinný hráč, je vada rozvržení – dveře publikace
  // zkusí další semínko, místo aby `verifyArcade` hru až potom odmítl (R3).
  const idle = replay(world, [], ARCADE_LIBRARY);
  if (idle.outcome === 'won') return { ok: false, reason: 'LAYOUT_FAILED', issues: [`a player who does nothing wins at tick ${idle.tick}`] };
  return {
    ok: true,
    value: {
      spec,
      specHash: canonicalHash(spec),
      seed,
      compilerVersion: ARCADE_COMPILER_VERSION,
      blueprint: null,
      arcade: world,
      worldHash: canonicalHash(world),
      mechanics: [],
      roles: [],
      winsAtTick: bot.tick,
    },
  };
}
