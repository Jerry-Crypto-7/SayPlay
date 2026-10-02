/**
 * Žánr Hod (P36A T10): hrdina stojí, nabije sílu, zamíří obloukem a trefuje
 * terč, koš nebo věž z kostek. Překládá na dnešní ovládání `throw` (pole
 * `throw_field`); scéna `components/play/arcade/throw` ho kreslí beze změny.
 *
 * Hloubka: hodiny (nečinný hráč prohraje, když doběhnou) a kombo zásahů
 * v řadě. **Životy hod nemá:** minutí už stojí hod (`spareThrows` jsou jeho
 * životy, HUD je ukazuje) – život navíc by trestal totéž dvakrát. **Délku
 * 30–90 s zatím nemá:** robot pole vyčistí za 5–20 s (terč a koš ~5 s, věž
 * ~13 s) a víc cílů na jedno pole se nevejde; delší hra chce kola (nové cíle
 * po vyčištění) – nový kus pravidla, protože vlny arény nesou číslo vlny
 * v čítači `ammo`, ve kterém hod drží zbývající hody.
 */

import { HOOP_CUES, THROW_GOALS, THROW_GOAL_LABELS, TOWER_CUES } from '../arcade/pieces/throw';

import { type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Hodiny výchozí (robot na nejdelší věži ~13 s) a v mezích. */
export const THROW_GENRE = { seconds: 30, minSeconds: 20, maxSeconds: 90 } as const;

/** Cíl hodu z věty: koš, věž (kuželky, krabice), jinak terč, když věta jmenuje, na co se hází. */
function goalOf(text: string): number | null {
  if (HOOP_CUES.test(text)) return THROW_GOALS.indexOf('hoop');
  if (TOWER_CUES.test(text)) return THROW_GOALS.indexOf('tower');
  return null;
}

export const throwGenre: GenreModule<'throw'> = {
  id: 'throw',
  modes: ['default'],
  cues: ['throw', 'toss', 'fling', 'hurl', 'launch', 'bowl', 'slingshot', 'catapult', 'golf', 'billiards', 'basketball'],
  heroClasses: ['animal', 'bird', 'robot', 'humanoid', 'monster'],
  paramBounds: {
    /** Index do `THROW_GOALS` (terč, koš, věž); bez něj podle semínka. */
    goal: { min: 0, max: THROW_GOALS.length - 1 },
    /** Hodů navíc nad počet cílů – kolikrát smí hráč minout. */
    spareThrows: { min: 0, max: 10 },
    seconds: { min: THROW_GENRE.minSeconds, max: THROW_GENRE.maxSeconds },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const { goal: goalIndex, spareThrows, seconds = THROW_GENRE.seconds } = spec.params ?? {};
    const goal = goalIndex === undefined ? undefined : THROW_GOALS[goalIndex];
    const label = spec.target?.label ?? (goal === undefined ? 'target' : THROW_GOAL_LABELS[goal]);
    return legacySpec(spec, {
      control: 'throw',
      controlParams: { ...(goal === undefined ? {} : { goal }), ...(spareThrows === undefined ? {} : { spareThrows }) },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Throw`,
      objective: { kind: 'defeat_targets', description: `Hit every ${label} in ${String(seconds)} seconds before you run out of throws.`, count: 3, role: 'target' },
      mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'lose' } }],
      roles: [
        { id: 'target', kind: 'target', label, count: 3 },
        { id: 'ball', kind: 'item', label: spec.collectible ?? 'ball' },
      ],
      tutorial: { goalLine: `Hit every ${label} in ${String(seconds)} seconds.`, controlsHint: 'Hold to power up, drag up or down to aim, let go to throw.' },
      mood: 'playful',
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting } = draftRoles(sentence, reading);
    const goal = goalOf(sentence.toLowerCase());
    return {
      genre: 'throw',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(goal === null ? {} : { params: { goal } }),
    };
  },
};
