/**
 * Knihovna arkádových kusů (P25A): id → kus. Svět odkazuje na kusy jménem
 * (`PieceRef`), jádro i ověření je hledají tady. Co tu není, neexistuje.
 */

import { makeAddonBot } from './addons';
import type { BotPiece } from './contract';
import type { ArcadeLibrary } from './kernel';
import { arenaEat, arenaLevel, growTo, moveFreeControl, surviveTime } from './pieces/arena';
import { arenaBot } from './pieces/arena-bot';
import { flapControl, flapTrack } from './pieces/flap';
import { flapBot } from './pieces/flap-bot';
import { platformControl, platformLevel } from './pieces/platform';
import { platformBot } from './pieces/platform-bot';
import { RULES } from './pieces/rules';
import { runnerControl, runnerTrack } from './pieces/runner';
import { runnerBot } from './pieces/runner-bot';
import { duelArena, duelControl } from './pieces/duel';
import { duelBot } from './pieces/duel-bot';
import { rhythmControl, rhythmLevel } from './pieces/rhythm';
import { rhythmBot } from './pieces/rhythm-bot';
import { gun, shooterControl, shooterRange } from './pieces/shooter';
import { shooterBot } from './pieces/shooter-bot';
import { SHOT_RULES } from './pieces/shots';
import { rivalFinish, steerControl, steerTrack } from './pieces/steer';
import { steerBot } from './pieces/steer-bot';
import { launch, throwControl, throwField } from './pieces/throw';
import { throwBot } from './pieces/throw-bot';
import { judgeRule, timingControl, timingLevel } from './pieces/timing';
import { timingBot } from './pieces/timing-bot';

const BASE_BOTS = {
  runner_bot: runnerBot,
  platform_bot: platformBot,
  flap_bot: flapBot,
  steer_bot: steerBot,
  arena_bot: arenaBot,
  shooter_bot: shooterBot,
  throw_bot: throwBot,
  timing_bot: timingBot,
  rhythm_bot: rhythmBot,
  duel_bot: duelBot,
} as const;

export const ARCADE_LIBRARY: ArcadeLibrary = {
  controls: {
    runner: runnerControl,
    platform: platformControl,
    flap: flapControl,
    steer: steerControl,
    move_free: moveFreeControl,
    shooter: shooterControl,
    throw: throwControl,
    timing: timingControl,
    rhythm: rhythmControl,
    duel: duelControl,
  },
  rules: { ...RULES, ...SHOT_RULES, gun, launch, rival_finish: rivalFinish, arena_eat: arenaEat, grow_to: growTo, survive_time: surviveTime, judge: judgeRule },
  generators: {
    runner_track: runnerTrack,
    platform_level: platformLevel,
    flap_track: flapTrack,
    steer_track: steerTrack,
    arena: arenaLevel,
    shooter_range: shooterRange,
    throw_field: throwField,
    timing_level: timingLevel,
    rhythm_level: rhythmLevel,
    duel_arena: duelArena,
  },
  bots: { ...BASE_BOTS, addon_bot: makeAddonBot(BASE_BOTS) as BotPiece },
};
