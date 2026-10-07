import { arenaGenre } from './arena';
import type { GenreId, GenreModule } from './contract';
import { duelGenre } from './duel';
import { flapGenre } from './flap';
import { platformerGenre } from './platformer';
import { questGenre } from './quest';
import { rhythmGenre } from './rhythm';
import { runnerGenre } from './runner';
import { shooterGenre } from './shooter';
import { throwGenre } from './throw';
import { timingGenre } from './timing';
import { voyageGenre } from './voyage';

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
};

