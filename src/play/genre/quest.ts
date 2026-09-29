/**
 * Žánr Úkol (P32): slovesa na předmětech – zapal, uhas, oprav, uvař. Pahýl
 * P32-0 hraje náhradu: sběr cílů v dnešní aréně `move_free`, bez stavů
 * předmětů. Proto oba režimy `fallback`; obsah modulu doplní stopa G.
 */

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Délka kola, když ji spec neříká; `arenaWinOf` bere 20–80 s. */
const ROUND_SECONDS = 40;

export const questGenre: GenreModule<'quest'> = {
  id: 'quest',
  modes: ['spatial', 'station'],
  cues: ['light', 'extinguish', 'cook', 'repair', 'free', 'flip'],
  heroClasses: ['humanoid', 'robot', 'animal', 'bird', 'monster'],
  paramBounds: { seconds: { min: 20, max: 80 } },
  availability: () => 'fallback',
  compile: (spec) => {
    const seconds = spec.params?.seconds ?? ROUND_SECONDS;
    const target = spec.target?.label ?? spec.collectible ?? 'star';
    return legacySpec(spec, {
      control: 'move_free',
      controlParams: { goal: 'grow' },
      archetype: 'survival_timer',
      title: `${titleCase(spec.hero)} Quest`,
      objective: { kind: 'survive', description: `Reach every ${target} within ${String(seconds)} seconds.`, seconds },
      mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'lose' } }],
      roles: [
        { id: 'hunter', kind: 'hazard', label: spec.enemy ?? 'shadow', count: 3 },
        { id: 'coin', kind: 'collectible', label: target, count: 12 },
      ],
      tutorial: { goalLine: `Reach every ${target} in time.`, controlsHint: 'Drag or arrows to move.' },
      mood: 'playful',
    });
  },
  draftFill: (sentence, reading) => ({ genre: 'quest', ...draftRoles(sentence, reading) }),
};
