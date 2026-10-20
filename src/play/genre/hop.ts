/**
 * Žánr Přeskákání silnice (P54C T9): hrdina skáče po polích přes silnice s auty, řeky s kládami a koleje s vlakem
 * (ovládání `hop`, generátor `hop_rows` v `arcade/pieces/hop.ts`). Co jezdí po silnici, je věc obsazení, které
 * se hrdina vyhýbá (`avoid` a ostatní nepřátelé, výchozí auto); kam jde, je věc `reach` (výchozí louka).
 *
 * Hloubka: cíl `rows` řad, tři třetiny širších a rychlejších pásů, 2 životy – auto, vlak a voda bez klády
 * uberou život a vrátí hrdinu na poslední trávu, orel vezme toho, kdo 6 s neskočí.
 *
 * Věty sem vede klasifikátor (T13b, sloveso `cross`: přes silnici, provoz, koleje, řeku po kládách; „crossy road“,
 * „frogger“) a skladba hraje recept buňky `hop.default` celý; režisér ho nenabízí (`DIRECTOR_PENDING`).
 */

import { HOP } from '../arcade/pieces/hop';
import { plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, castFor, draftRoles, legacySpec, livesMechanic, titleCase } from './contract';

/** Výchozí věci, když je věta nejmenuje: auto na silnici a louka za ní. */
export const HOP_DEFAULTS = { traffic: 'car', goal: 'meadow' } as const;

/** Role obsazení, kterou přeskákání hraje jako provoz na silnici: všechno, co hrdinovi škodí. */
const TRAFFIC_DOES = ['avoid', 'chase_me', 'fight', 'shoot_at', 'throw_at'] as const;

/**
 * Kdo přechází, když není podmětem (P54C T13b): koho věta převádí („help the duck cross the highway“, „hop the
 * hedgehog across“), nebo kdo skáče ve vedlejší frázi („crossy road with a frog hopping“). Jinak by hrdinu dalo prostředí.
 */
const LED_HERO = /\b(?:help|helps|helping|guide|guides|guiding|get|gets|take|takes|hop|move)\s+(?:the\s+|a\s+|an\s+|your\s+|my\s+|little\s+)*(?!(?:across|over|through|to|it|them|him|her|me|us|everyone)\b)([a-z]+(?:\s+[a-z]+)?)\s+(?:cross|crosses|across|over|safely)\b|\b(?:with|as)\s+(?:a|an|the)\s+([a-z]+)\s+(?:hopping|jumping|crossing|leaping)\b/;
/** Co jezdí po silnici, když ho věta neřekla slovesem: „a busy road full of cars“, „country lanes full of tractors“. */
const FULL_OF = /\bfull of ([a-z]+)\b/;

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

export const hopGenre: GenreModule<'hop'> = {
  id: 'hop',
  modes: ['default'],
  // Narážky žádné: věty k žánru vede klasifikátor jen se znakem žánru (T13b), narážka by bod přidala i skokům plošinovky.
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
    const { hero: subject, setting, cast } = draftRoles(sentence, reading);
    const text = sentence.toLowerCase();
    const led = LED_HERO.exec(text);
    const hero = led === null ? subject : singular((led[1] ?? led[2]) as string);
    // Přeskákání zná jen dvě role: kam se jde, a co jezdí po silnici.
    const roles = (cast ?? []).map((item): CastItem => (item.does === 'reach' ? item : { ...item, does: 'avoid' }));
    const traffic = FULL_OF.exec(text)?.[1];
    if (traffic !== undefined && !roles.some((item) => item.does === 'avoid')) roles.unshift({ label: singular(traffic), does: 'avoid' });
    return {
      genre: 'hop',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(setting === undefined ? {} : { setting }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
