/**
 * Žánr Hod (P36A T10): hrdina stojí, nabije sílu, zamíří obloukem a trefuje
 * terč, koš nebo věž z kostek. Překládá na dnešní ovládání `throw` (pole
 * `throw_field`); scéna `components/play/arcade/throw` ho kreslí beze změny.
 *
 * Hloubka: hodiny (nečinný hráč prohraje, když doběhnou) a kombo zásahů
 * v řadě. **Životy hod nemá:** minutí už stojí hod (`spareThrows` jsou jeho
 * životy, HUD je ukazuje) – život navíc by trestal totéž dvakrát. **Délka
 * 30–90 s jde z kol (P36A F5):** jedno pole robot vyčistí za 5–13 s, takže
 * pole dostane rozpočet robota `budget` a naplánuje si tolik kol, kolik se do
 * něj vejde (druh cíle losuje semínko, žánr ho nezná); hodiny = rozpočet ×
 * faktor + rezerva jako hodiny úkolu. Čas z věty je hodinami a rozpočet se
 * z nich spočítá zpátky.
 */

import { HOOP_CUES, THROW_GOALS, THROW_GOAL_LABELS, TOWER_CUES, throwBudgetIn } from '../arcade/pieces/throw';
import { WAVE_PLAN } from '../arcade/pieces/waves';

import { type GenreModule, castFor, draftRoles, legacySpec, titleCase } from './contract';

/** Rozpočet robota na celou hru bez času z věty (sonda F5: 40–47 s ve všech druzích cíle) a meze hodin. */
export const THROW_GENRE = { budget: 48, minSeconds: 20, maxSeconds: 90 } as const;

/** Rozpočet robota a hodiny: bez času z věty výchozí rozpočet, s ním rozpočet, který se do hodin vejde (aspoň 1 s). */
export function throwClock(seconds: number | undefined): { readonly budget: number; readonly seconds: number } {
  if (seconds === undefined) {
    return { budget: THROW_GENRE.budget, seconds: Math.min(WAVE_PLAN.clockMax, Math.round(THROW_GENRE.budget * WAVE_PLAN.clockFactor + WAVE_PLAN.clockMargin)) };
  }
  return { budget: throwBudgetIn(seconds), seconds };
}

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
  clockParam: 'seconds',
  availability: () => 'ready',
  compile: (spec) => {
    const { goal: goalIndex, spareThrows } = spec.params ?? {};
    const { budget, seconds } = throwClock(spec.params?.seconds);
    const goal = goalIndex === undefined ? undefined : THROW_GOALS[goalIndex];
    // Terč je věc, na kterou se hází; bez ní nejbližší protivník nebo cíl (P39).
    const label = castFor(spec, 'throw_at', 'shoot_at', 'fight', 'chase_me', 'avoid', 'reach')?.label ?? (goal === undefined ? 'target' : THROW_GOAL_LABELS[goal]);
    return legacySpec(spec, {
      control: 'throw',
      controlParams: { ...(goal === undefined ? {} : { goal }), ...(spareThrows === undefined ? {} : { spareThrows }), budget },
      archetype: 'combat_lite',
      title: `${titleCase(spec.hero)} Throw`,
      objective: { kind: 'defeat_targets', description: `Hit every ${label} in ${String(seconds)} seconds before you run out of throws.`, count: 3, role: 'target' },
      mechanics: [{ id: 'timer', params: { id: 'clock', seconds, onEnd: 'lose' } }],
      roles: [
        { id: 'target', kind: 'target', label, count: 3 },
        { id: 'ball', kind: 'item', label: castFor(spec, 'collect')?.label ?? 'ball' },
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
