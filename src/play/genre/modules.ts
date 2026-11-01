import { arenaGenre } from './arena';
import { arrowsGenre } from './arrows';
import { buildshiftGenre } from './buildshift';
import { catchGenre } from './catch';
import type { GenreId, GenreModule } from './contract';
import { crowdGenre } from './crowd';
import { defenseGenre } from './defense';
import { drawsaveGenre } from './drawsave';
import { duelGenre } from './duel';
import { flapGenre } from './flap';
import { holeGenre } from './hole';
import { hopGenre } from './hop';
import { mergeGenre } from './merge';
import { minigolfGenre } from './minigolf';
import { platformerGenre } from './platformer';
import { pushGenre } from './push';
import { questGenre } from './quest';
import { railfpsGenre } from './railfps';
import { rhythmGenre } from './rhythm';
import { runnerGenre } from './runner';
import { shooterGenre } from './shooter';
import { sliceGenre } from './slice';
import { sortGenre } from './sort';
import { stealGenre } from './steal';
import { stuntGenre } from './stunt';
import { survivorGenre } from './survivor';
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
  // P66 T2: kostry, které nehrají – každá úloha žánru (T5–T9) přepíše jen svůj soubor.
  survivor: survivorGenre,
  hole: holeGenre,
  steal: stealGenre,
  sort: sortGenre,
  arrows: arrowsGenre,
  // P68 T1: kostry pěti her z jiných pohledů – každá kategorie přepíše jen svůj soubor; zapne je P68-I („zapoj X“).
  stunt: stuntGenre,
  minigolf: minigolfGenre,
  railfps: railfpsGenre,
  buildshift: buildshiftGenre,
  drawsave: drawsaveGenre,
};

