/**
 * Fakta listu „About this game“ (P23-C T8, od P70C T3 pro hráče), počítaná **na serveru**.
 *
 * Věty o žánru a vysvětlení mechanik táhnou registr se zodem; do klientského
 * bundlu proto nejde registr, ale hotové věty odsud. Tenhle modul importuje jen
 * serverová stránka `/play/[id]`. Vývojářská fakta (tiky výhry, replay, klíčové
 * body) hráč nevidí – jsou v `GET /api/play/games/:id` a nástrojích `/play/lab`.
 */

import type { ArcadeWorld } from '@/play/arcade/contract';
import { GENRES, type GenreId } from '@/play/genre/contract';
import { loseLineOf } from '@/play/lose-line';
import { MECHANICS, type MechanicId } from '@/play/registry';
import type { GameSpecV1 } from '@/play/spec';
import type { PublishedGame } from '@/play/version';

/**
 * Kdo hru navrhl. `draft` = okamžitý návrh ze slov (bez modelu), `ai` = model
 * (vylepšení návrhu, nebo rovnou režisér), `remix` = změna čipem nad cizí hrou.
 * Návrh se nikdy nesmí vydávat za `ai` – panel by lhal porotci přesně tam,
 * kde se ptá, co udělala AI.
 */
export type Authorship = 'ai' | 'draft' | 'remix';

export function authorshipOf(game: Pick<PublishedGame, 'origin' | 'sentence' | 'relation'>): Authorship {
  if (game.origin !== undefined) return 'draft';
  if (game.relation === 'upgrade' || game.sentence !== undefined) return 'ai';
  return 'remix';
}

/** Co se z věty stalo – panel „From your sentence“. */
export interface ReadFacts {
  readonly authorship: Authorship;
  /** Kdo větu návrhu přečetl (P29B T6): lokální model, nebo klíčová slova. */
  readonly readBy: 'model' | 'keywords';
  readonly sentence: string | null;
  readonly game: string;
  readonly world: string;
  readonly you: string | null;
  readonly against: readonly string[];
}

const CONTROL_NAME: Readonly<Record<string, string>> = {
  runner: 'Runner',
  platform: 'Platformer',
  flap: 'Flying',
  steer: 'Racing',
  move_free: 'Arena',
  shooter: 'Shooter',
  throw: 'Throwing',
  timing: 'Timing',
  rhythm: 'Rhythm',
  duel: 'Duel',
};

const OPPONENT_KINDS: ReadonlySet<string> = new Set(['hazard', 'chaser', 'patrol']);

const words = (id: string): string => id.replaceAll('_', ' ');

export function readFacts(spec: GameSpecV1, authorship: Authorship, sentence: string | null, readBy: ReadFacts['readBy'] = 'keywords'): ReadFacts {
  const control = spec.control === undefined || spec.control === 'tap_go' ? null : spec.control;
  const game = control === null ? words(spec.archetype) : (CONTROL_NAME[control] ?? words(control));
  return {
    authorship,
    readBy,
    sentence,
    game: game.charAt(0).toUpperCase() + game.slice(1),
    world: `${spec.theme.setting} · ${spec.theme.mood}`,
    you: spec.roles.find((role) => role.kind === 'player')?.label ?? null,
    against: [...new Set(spec.roles.filter((role) => OPPONENT_KINDS.has(role.kind)).map((role) => role.label))],
  };
}

/** Oddíl „How to play“ (P70C T3): jak vyhrát, jak prohrát, ovládání a 2–3 věty, jak hra běží. */
export interface LabFacts {
  readonly goal: string;
  /** `loseLineOf`; `null` = hra prohrát nejde. */
  readonly lose: string | null;
  /** `tutorial.controlsHint`; dotyková verze se skládá na klientu (`touchHint`). */
  readonly controls: string;
  readonly how: readonly string[];
}

/**
 * Jak žánr běží, dvěma větami pro hráče (P70C T3). Jen to, co platí v každém režimu žánru – prohru a cíl
 * konkrétní hry říkají `lose` a `goal`. Nový žánr bez vět shodí typ `Record<GenreId, …>`.
 */
const HOW_BY_GENRE: Readonly<Record<GenreId, readonly [string, string]>> = {
  runner: ['You run forward on your own – switch lanes, jump and slide past what is in the way.', 'The track gets faster and busier as you go.'],
  platformer: ['Run and jump from platform to platform to reach the goal.', 'Hold jump longer to jump higher.'],
  arena: ['Move freely around a walled area.', 'Collect things, escape whoever chases you or beat the enemies – the goal says which.'],
  voyage: ['Steer freely through the gates on your way to the finish.', 'When you have to land, slow down and touch down softly.'],
  quest: ['Walk up to each object and use it – light it, fix it or cook it.', 'Each one shows its progress as you work on it.'],
  shooter: ['You stand in one place, aim and shoot.', 'Targets and waves of enemies come towards you.'],
  throw: ['Hold to charge power, aim and let go to throw.', 'Hit the target, sink the basket or knock down the tower.'],
  timing: ['Something swings back and forth – tap to stop it in the right spot.', 'The closer to the mark, the better.'],
  rhythm: ['Notes slide down four lanes towards the line.', 'Tap a lane just as its note reaches the line, on the beat.'],
  duel: ['Dodge when your rival winds up an attack.', 'Strike back in the gap right after it.'],
  flap: ['You fly forward on your own and each tap lifts you up.', 'Fly through the gaps without touching anything.'],
  catch: ['Things fall in five lanes – move under them to catch them.', 'Dodge the bombs.'],
  whack: ['Targets pop out of five holes – hit them before they hide.', 'Leave the good ones alone; hitting one costs a life.'],
  defense: ['Enemies march down five lanes towards your wall.', 'Tap a lane to shoot and hold to place a defender.'],
  slice: ['Things fly up in arcs – swipe to slice them.', 'Leave the bombs alone; slicing one costs a life.'],
  hop: ['Hop forward row by row across roads, rivers and rail tracks.', 'Ride the logs over water and keep clear of cars and trains.'],
  crowd: ['Lead your crowd through gates that add, multiply or take people away.', 'At the end your crowd fights a giant – the bigger the crowd, the better.'],
  merge: ['Drop things into the box.', 'Two of the same that touch merge into a bigger one.'],
  push: ['Charge at your rival to push them out of the ring.', 'In the last round the ring shrinks.'],
  survivor: ['Move around while your hero shoots the nearest enemy by themselves.', 'Between waves pick one of three upgrades; the last round is a boss.'],
  hole: ['Drag the hole around – anything smaller than it falls in.', 'The more it swallows, the bigger it grows.'],
  steal: ['Run to the other base, grab the loot and bring it back to yours.', 'Guards chase you and take the loot back if they touch you.'],
  sort: ['Tap a queue to send its front item to the matching bin.', 'Items with no matching bin wait on a small spare shelf.'],
  arrows: ['Tap a piece to send it off the way its arrow points.', 'If something is in the way, it bumps and you lose a heart.'],
  stunt: ['Drive the track, jump the ramps and smash through the piles.', 'Hitting the barrier costs a life.'],
  minigolf: ['Hold to charge your shot, then let go to hit the ball.', 'Bumpers and walls bounce the ball – use them.'],
  railfps: ['You ride along a rail – turn to aim and tap to shoot.', 'An enemy that reaches you takes a life.'],
  buildshift: ['Spend your coins on ovens, counters and shelves, then open the shop.', 'Send your staff between them to serve each customer what they want.'],
  drawsave: ['Draw lines to shield your character.', 'Things fall from above and bounce off your lines.'],
};

const isGenre = (id: string | undefined): id is GenreId => (GENRES as readonly string[]).includes(id ?? '');

/** Věty „How to play“: žánr specu (starší spec bez žánru podle ovládání), jinak vysvětlení mechanik z registru. */
export function howLinesOf(spec: GameSpecV1): readonly string[] {
  const genre = spec.genre?.id ?? (isGenre(spec.control) ? spec.control : null);
  if (genre !== null) return HOW_BY_GENRE[genre];
  return spec.mechanics.slice(0, 3).map((mechanic) => MECHANICS[mechanic.id as MechanicId].explanation);
}

export function labFacts(spec: GameSpecV1, world: ArcadeWorld | null): LabFacts {
  return { goal: spec.tutorial.goalLine, lose: loseLineOf(spec, world), controls: spec.tutorial.controlsHint, how: howLinesOf(spec) };
}
