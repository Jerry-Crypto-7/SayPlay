/**
 * Arkádová cesta kompilátoru (P25A, T5): `GameSpec` s `control: 'runner'` +
 * seed → `ArcadeWorld` a `CompiledGame`.
 *
 * Ze specu se čte ovládání a jeho parametry a dvě koření z registru mechanik:
 * `health` (náraz ubere život místo prohry) a `timer` s `onEnd: 'lose'`
 * (časový limit). Ostatní mechaniky a role popisují příběh pro obálku, trať
 * je z generátoru. Hru, kterou robot nevyhraje, kompilátor vrátí jako
 * `UNWINNABLE` – dveře publikace pak zkusí další semínko.
 */

import { canonicalHash } from '@/ir/worlddoc';
import { type CompileGameResult, GAME_COMPILER_VERSION } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';

import { ARCADE_LIMITS, ARCADE_RUNTIME_VERSION, type ArcadeWorld, type PieceRef } from './contract';
import { buildWorld } from './kernel';
import { ARCADE_LIBRARY } from './library';
import { runnerTrack } from './pieces/runner';
import { runBot } from './verify';

/** Verze kompilátoru arkádové hry: mřížkový kompilátor + verze jádra. */
export const ARCADE_COMPILER_VERSION = `${GAME_COMPILER_VERSION}/${ARCADE_RUNTIME_VERSION}`;

export type ArcadeWorldResult = { readonly ok: true; readonly world: ArcadeWorld } | { readonly ok: false; readonly issues: readonly string[] };

/** Spec + seed → svět. Bez ověření robotem – to dělá `compileArcade`. */
export function arcadeWorldOf(spec: GameSpecV1, seed: number): ArcadeWorldResult {
  const params = runnerTrack.params.parse({ ...spec.controlParams });
  const level = runnerTrack.generate(seed, params);
  const health = spec.mechanics.find((mechanic) => mechanic.id === 'health')?.params as { readonly max: number } | undefined;
  const timer = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds: number; readonly onEnd: string } | undefined;

  const rules: PieceRef[] = [
    { id: 'hit', params: { role: 'obstacle', effect: health === undefined ? 'lose' : 'damage' } },
    { id: 'pickup', params: {} },
    { id: 'finish', params: {} },
  ];
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  if (timer?.onEnd === 'lose') rules.push({ id: 'time_limit', params: { seconds: Math.min(ARCADE_LIMITS.maxTicks / 60, Math.max(10, timer.seconds)) } });

  const built = buildWorld(
    { seed, control: { id: 'runner', params: { speed: params.speed } }, rules, bot: { id: 'runner_bot', params: {} }, level, ...(health === undefined ? {} : { health: health.max }) },
    ARCADE_LIBRARY,
  );
  return built.ok ? { ok: true, world: built.world } : built;
}

export function compileArcade(spec: GameSpecV1, seed: number): CompileGameResult {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) return { ok: false, reason: 'WORLD_REJECTED', issues: made.issues };
  const { world } = made;
  const bot = runBot(world);
  if (bot.outcome !== 'won') return { ok: false, reason: 'UNWINNABLE', issues: [`the bot ${bot.outcome === 'lost' ? 'lost' : 'did not finish'} at tick ${bot.tick}, ${bot.distanceM} m into the track`] };
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
