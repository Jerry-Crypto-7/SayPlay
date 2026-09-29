/**
 * Žánr Aréna (P32): volný pohyb po ohraničené ploše. Režimy *uteč*, *sbírej*
 * a *bojuj*. Pahýl P32-0 překládá útěk a sběr na dnešní `move_free`
 * (přežít / vyrůst) a souboj na `duel`; obsah modulu doplní stopa E.
 */

import { type GenreModule, type GenreSpecOf, type LegacyGame, draftRoles, legacySpec, titleCase } from './contract';

/** Délka kola, když ji spec neříká; `arenaWinOf` bere 20–80 s. */
const ROUND_SECONDS = 40;

/** Dnešní aréna `move_free`: lovci a potrava. */
function freeRoam(spec: GenreSpecOf<'arena'>): Pick<LegacyGame, 'roles' | 'control' | 'archetype'> {
  return {
    control: 'move_free',
    archetype: 'survival_timer',
    roles: [
      { id: 'hunter', kind: 'hazard', label: spec.enemy ?? 'hunter', count: 3 },
      { id: 'coin', kind: 'collectible', label: spec.collectible ?? 'coin', count: 12 },
    ],
  };
}

function compileArena(spec: GenreSpecOf<'arena'>) {
  const seconds = spec.params?.seconds ?? ROUND_SECONDS;
  const title = titleCase(spec.hero);
  if (spec.mode === 'fight') {
    return legacySpec(spec, {
      control: 'duel',
      controlParams: { difficulty: 'normal' },
      archetype: 'hazard_crossing',
      title: `${title} Duel`,
      objective: { kind: 'reach', description: `Dodge the swings, strike in the openings and knock out the ${spec.enemy ?? 'rival'}.`, role: 'finish' },
      mechanics: [{ id: 'health', params: { max: 3 } }],
      roles: [
        { id: 'rival', kind: 'hazard', label: spec.enemy ?? 'rival' },
        { id: 'finish', kind: 'exit', label: 'knockout' },
      ],
      tutorial: { goalLine: 'Dodge the wind-up, strike in the opening. Knock out the rival.', controlsHint: 'Tap right or Space to strike, tap left or Down to dodge.' },
      mood: 'tense',
      targetDurationSec: 45,
    });
  }
  if (spec.mode === 'escape') {
    return legacySpec(spec, {
      ...freeRoam(spec),
      title: `${title} Escape`,
      objective: { kind: 'survive', description: `Stay away from the ${spec.enemy ?? 'hunters'} for ${String(seconds)} seconds.`, seconds },
      mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'win' } }],
      tutorial: { goalLine: `Survive ${String(seconds)} seconds.`, controlsHint: 'Drag or arrows to move.' },
      mood: 'tense',
    });
  }
  return legacySpec(spec, {
    ...freeRoam(spec),
    controlParams: { goal: 'grow' },
    title: `${title} Feast`,
    objective: { kind: 'survive', description: `Collect ${spec.collectible ?? 'coins'} to grow and outgrow the ${spec.enemy ?? 'hunters'} within ${String(seconds)} seconds.`, seconds },
    mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'lose' } }],
    tutorial: { goalLine: `Outgrow every hunter within ${String(seconds)} seconds.`, controlsHint: 'Drag or arrows to move.' },
    mood: 'playful',
  });
}

export const arenaGenre: GenreModule<'arena'> = {
  id: 'arena',
  modes: ['escape', 'collect', 'fight'],
  cues: ['chase', 'catch', 'escape', 'collect', 'gather', 'fight', 'duel', 'battle'],
  heroClasses: ['animal', 'bird', 'robot', 'vehicle', 'humanoid', 'monster'],
  paramBounds: { seconds: { min: 20, max: 80 } },
  availability: () => 'ready',
  compile: compileArena,
  draftFill: (sentence, reading) => ({ genre: 'arena', ...draftRoles(sentence, reading) }),
};
