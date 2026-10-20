/**
 * Žánr Přeskákání silnice (P54C T9): hrdina skáče po polích přes silnice s auty, řeky s kládami a koleje s vlakem
 * (ovládání `hop`, generátor `hop_rows` v `arcade/pieces/hop.ts`). Co jezdí po silnici, je věc obsazení, které
 * se hrdina vyhýbá (`avoid` a ostatní nepřátelé, výchozí auto); kam jde, je věc `reach` (výchozí louka).
 *
 * Hloubka: cíl `rows` řad, tři třetiny širších a rychlejších pásů, 2 životy – auto, vlak a voda bez klády
 * uberou život a vrátí hrdinu na poslední trávu, orel vezme toho, kdo 6 s neskočí.
 *
 * Věty sem klasifikátor zatím nevede (T13b) a režisér ho nenabízí (`DIRECTOR_PENDING`); hraje ho buňka `hop.default`.
 */

import { HOP } from '../arcade/pieces/hop';
import { plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věci, když je věta nejmenuje: auto na silnici a louka za ní. */
export const HOP_DEFAULTS = { traffic: 'car', goal: 'meadow' } as const;

/** Role obsazení, kterou přeskákání hraje jako provoz na silnici: všechno, co hrdinovi škodí. */
const TRAFFIC_DOES = ['avoid', 'chase_me', 'fight', 'shoot_at', 'throw_at'] as const;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const hopGenre: GenreModule<'hop'> = {
  id: 'hop',
  modes: ['default'],
  // Narážky žádné: věty k žánru povede až klasifikátor (T13b), narážka by bod přidala i skokům plošinovky.
  cues: [],
  heroClasses: ['animal', 'bird', 'humanoid', 'robot', 'monster'],
  paramBounds: {
    rows: { min: HOP.rows.min, max: HOP.rows.max },
  },
  availability: () => 'ready',
  compile: (spec) => {
    const rows = spec.params?.rows ?? HOP.rows.default;
    const traffic = castFor(spec, ...TRAFFIC_DOES)?.label ?? HOP_DEFAULTS.traffic;
    const goal = castFor(spec, 'reach')?.label ?? HOP_DEFAULTS.goal;
    const vehicles = plural(singular(traffic), 2);
    return legacySpec(spec, {
      control: 'hop',
      controlParams: { generator: 'hop_rows', tuning: { rows } },
      archetype: 'hazard_crossing',
      title: `${titleCase(spec.hero)} Crossing`,
      objective: {
        kind: 'reach',
        description: fit(120, `Hop ${String(rows)} rows across roads, rivers and rails to the ${goal}. Dodge the ${vehicles}.`, `Hop ${String(rows)} rows to the ${goal}.`),
        count: rows,
        role: 'finish',
      },
      mechanics: [{ ...livesMechanic(), params: { max: HOP.lives } }],
      roles: [
        { id: 'obstacle', kind: 'hazard', label: traffic },
        { id: 'finish', kind: 'exit', label: goal },
      ],
      tutorial: {
        goalLine: fit(50, `Cross ${String(rows)} rows to the ${goal}!`, `Cross ${String(rows)} rows!`),
        controlsHint: 'Tap to hop forward, swipe to hop sideways or back. Arrows work too.',
      },
      mood: 'playful',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Přeskákání zná jen dvě role: kam se jde, a co jezdí po silnici.
    const roles = (cast ?? []).map((item): CastItem => (item.does === 'reach' ? item : { ...item, does: 'avoid' }));
    return {
      genre: 'hop',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
