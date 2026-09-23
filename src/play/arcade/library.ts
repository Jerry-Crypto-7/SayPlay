/**
 * Knihovna arkádových kusů (P25A): id → kus. Svět odkazuje na kusy jménem
 * (`PieceRef`), jádro i ověření je hledají tady. Co tu není, neexistuje.
 */

import type { ArcadeLibrary } from './kernel';
import { flapControl, flapTrack } from './pieces/flap';
import { flapBot } from './pieces/flap-bot';
import { platformControl, platformLevel } from './pieces/platform';
import { platformBot } from './pieces/platform-bot';
import { RULES } from './pieces/rules';
import { runnerControl, runnerTrack } from './pieces/runner';
import { runnerBot } from './pieces/runner-bot';
import { gun, shooterControl, shooterRange } from './pieces/shooter';
import { shooterBot } from './pieces/shooter-bot';
import { SHOT_RULES } from './pieces/shots';
import { launch, throwControl, throwField } from './pieces/throw';

export const ARCADE_LIBRARY: ArcadeLibrary = {
  controls: { runner: runnerControl, platform: platformControl, flap: flapControl, shooter: shooterControl, throw: throwControl },
  rules: { ...RULES, ...SHOT_RULES, gun, launch },
  generators: { runner_track: runnerTrack, platform_level: platformLevel, flap_track: flapTrack, shooter_range: shooterRange, throw_field: throwField },
  bots: { runner_bot: runnerBot, platform_bot: platformBot, flap_bot: flapBot, shooter_bot: shooterBot },
};
