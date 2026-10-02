/**
 * Dvojníci modulů žánrů (P32B): testovací moduly s řízenou `availability`.
 *
 * Skutečné moduly v `../{runner,platformer,arena,voyage,quest}.ts` plní stopy
 * A, E, F a G souběžně s P32B a do jejich sloučení jsou to pahýly (Úkol celý
 * `fallback`). Klasifikátor, draft a oprava režiséra se proto zkoušejí proti
 * tomuhle: narážky a třídy hrdinů jsou zamrzlá kopie pahýlů P32-0, překlad je
 * nejmenší platný `GameSpecV1` pro každý žánr. Přejímka se skutečnými moduly je
 * P32B T6.
 */

import { GENRE_MODES, type GenreId, type GenreModule, type GenreMode, type GenreSpec, type GenreSpecOf, type LegacyGame, type ModelClass, draftRoles, legacySpec, titleCase } from '../contract';

const CUES: { readonly [G in GenreId]: readonly string[] } = {
  runner: ['run', 'dash', 'slide', 'ski', 'sled'],
  platformer: ['jump', 'climb', 'hop', 'leap'],
  arena: ['chase', 'catch', 'escape', 'collect', 'gather', 'fight', 'duel', 'battle'],
  voyage: ['sail', 'fly', 'ride', 'drive', 'pilot', 'land'],
  quest: ['light', 'extinguish', 'cook', 'repair', 'free', 'flip'],
  shooter: ['shoot', 'blast', 'aim'],
  throw: ['throw', 'toss', 'bowl'],
};

const HERO_CLASSES: { readonly [G in GenreId]: readonly ModelClass[] } = {
  runner: ['animal', 'bird', 'humanoid', 'robot', 'vehicle'],
  platformer: ['animal', 'bird', 'humanoid', 'robot', 'monster'],
  arena: ['animal', 'bird', 'robot', 'vehicle', 'humanoid', 'monster'],
  voyage: ['boat', 'aircraft', 'vehicle', 'animal', 'humanoid'],
  quest: ['humanoid', 'robot', 'animal', 'bird', 'monster'],
  shooter: ['humanoid', 'robot', 'animal', 'monster'],
  throw: ['humanoid', 'robot', 'animal', 'monster'],
};

/** Hra s cílovou čárou: běžec, skákačka, plavba. */
function track(spec: GenreSpec, control: 'runner' | 'platform' | 'steer'): LegacyGame {
  return {
    control,
    ...(control === 'runner' ? {} : { controlParams: control === 'platform' ? { checkpoints: true } : { difficulty: 'normal' } }),
    archetype: 'hazard_crossing',
    title: `${titleCase(spec.hero)} Run`,
    objective: { kind: 'reach', description: `Reach the finish past every ${spec.enemy ?? 'rock'}.`, role: 'finish' },
    roles: [
      { id: 'obstacle', kind: 'hazard', label: spec.enemy ?? 'rock', count: 5 },
      { id: 'coin', kind: 'collectible', label: spec.target?.label ?? spec.collectible ?? 'coin', count: 3 },
      { id: 'finish', kind: 'exit', label: 'finish line' },
    ],
    tutorial: { goalLine: 'Reach the finish line.', controlsHint: 'Arrows to move.' },
    mood: 'fast',
  };
}

/** Aréna a Úkol: volný pohyb, přežít do konce kola. */
function roam(spec: GenreSpec): LegacyGame {
  return {
    control: 'move_free',
    archetype: 'survival_timer',
    title: `${titleCase(spec.hero)} Arena`,
    objective: { kind: 'survive', description: `Stay away from the ${spec.enemy ?? 'hunters'} for 40 seconds.`, seconds: 40 },
    mechanics: [{ id: 'timer', params: { id: 'clock', seconds: 40, onEnd: 'win' } }],
    roles: [
      { id: 'hunter', kind: 'hazard', label: spec.enemy ?? 'hunter', count: 3 },
      { id: 'coin', kind: 'collectible', label: spec.target?.label ?? spec.collectible ?? 'coin', count: 12 },
    ],
    tutorial: { goalLine: 'Survive 40 seconds.', controlsHint: 'Drag or arrows to move.' },
    mood: 'tense',
  };
}

function duel(spec: GenreSpec): LegacyGame {
  return {
    control: 'duel',
    controlParams: { difficulty: 'normal' },
    archetype: 'hazard_crossing',
    title: `${titleCase(spec.hero)} Duel`,
    objective: { kind: 'reach', description: `Knock out the ${spec.enemy ?? 'rival'}.`, role: 'finish' },
    mechanics: [{ id: 'health', params: { max: 3 } }],
    roles: [
      { id: 'rival', kind: 'hazard', label: spec.enemy ?? 'rival' },
      { id: 'finish', kind: 'exit', label: 'knockout' },
    ],
    tutorial: { goalLine: 'Knock out the rival.', controlsHint: 'Tap right to strike, left to dodge.' },
    mood: 'tense',
  };
}

function compileDouble(spec: GenreSpec) {
  if (spec.genre === 'arena' && spec.mode === 'fight') return legacySpec(spec, duel(spec));
  if (spec.genre === 'arena' || spec.genre === 'quest' || spec.genre === 'shooter' || spec.genre === 'throw') return legacySpec(spec, roam(spec));
  return legacySpec(spec, track(spec, spec.genre === 'runner' ? 'runner' : spec.genre === 'platformer' ? 'platform' : 'steer'));
}

function double<G extends GenreId>(id: G, fallback: ReadonlySet<string>): GenreModule<G> {
  return {
    id,
    modes: GENRE_MODES[id] as readonly GenreMode<G>[],
    cues: CUES[id],
    heroClasses: HERO_CLASSES[id],
    paramBounds: {},
    availability: (mode) => (fallback.has(`${id}.${mode}`) ? 'fallback' : 'ready'),
    compile: (spec) => compileDouble(spec),
    draftFill: (sentence, reading) => ({ genre: id, ...draftRoles(sentence, reading) }) as Partial<GenreSpecOf<G>>,
  };
}

/** Pět dvojníků; `fallback` jmenuje režimy (`quest.station`), které hrají náhradu. Bez něj je všechno `ready`. */
export function genreDoubles(fallback: readonly string[] = []): { readonly [G in GenreId]: GenreModule<G> } {
  const set = new Set(fallback);
  return {
    runner: double('runner', set),
    platformer: double('platformer', set),
    arena: double('arena', set),
    voyage: double('voyage', set),
    quest: double('quest', set),
    shooter: double('shooter', set),
    throw: double('throw', set),
  };
}
