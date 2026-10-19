import { arenaGenre } from './arena';
import { catchGenre } from './catch';
import type { GenreId, GenreModule } from './contract';
import { crowdGenre } from './crowd';
import { defenseGenre } from './defense';
import { duelGenre } from './duel';
import { flapGenre } from './flap';
import { hopGenre } from './hop';
import { mergeGenre } from './merge';
import { platformerGenre } from './platformer';
import { pushGenre } from './push';
import { questGenre } from './quest';
import { rhythmGenre } from './rhythm';
import { runnerGenre } from './runner';
import { shooterGenre } from './shooter';
import { sliceGenre } from './slice';
import { throwGenre } from './throw';
import { timingGenre } from './timing';
import { voyageGenre } from './voyage';
import { whackGenre } from './whack';

export const GENRE_MODULES: { readonly [G in GenreId]: GenreModule<G> } = {
  runner: runnerGenre,
  platformer: platformerGenre,
  arena: arenaGenre,
  voyage: voyageGenre,
  quest: questGenre,
  shooter: shooterGenre,
  throw: throwGenre,
  timing: timingGenre,
  rhythm: rhythmGenre,
  duel: duelGenre,
  flap: flapGenre,
  catch: catchGenre,
  whack: whackGenre,
  defense: defenseGenre,
  slice: sliceGenre,
  hop: hopGenre,
  crowd: crowdGenre,
  merge: mergeGenre,
  push: pushGenre,
};

